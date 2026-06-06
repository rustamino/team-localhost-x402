"""
Job model and store.

Job lifecycle:
  created → slicing → quoted → checkout → paid → printing → done
                                                           → failed
                        ↓           ↓
                     failed      expired  (payment TTL elapsed)
                                    ↓
                                 cancelled (explicit cancel before paid)
"""

import time
from dataclasses import dataclass, field
from decimal import Decimal
from enum import Enum
from typing import Any
from uuid import uuid4

from .pricing import PriceQuote


class JobStatus(str, Enum):
    created   = "created"    # accepted, STL queued for slicing
    slicing   = "slicing"    # slicer running
    quoted    = "quoted"     # price known, waiting for user to confirm
    checkout  = "checkout"   # x402 order created, waiting for payment
    paid      = "paid"       # on-chain payment confirmed
    printing  = "printing"   # Pi started print
    done      = "done"       # print finished
    failed    = "failed"     # slicer or print error
    expired   = "expired"    # payment TTL elapsed
    cancelled = "cancelled"  # cancelled before payment


# Transitions allowed from each status
_ALLOWED: dict[JobStatus, set[JobStatus]] = {
    JobStatus.created:   {JobStatus.slicing, JobStatus.failed},
    JobStatus.slicing:   {JobStatus.quoted,  JobStatus.failed},
    JobStatus.quoted:    {JobStatus.checkout, JobStatus.cancelled, JobStatus.failed},
    JobStatus.checkout:  {JobStatus.paid, JobStatus.expired, JobStatus.cancelled},
    JobStatus.paid:      {JobStatus.printing},
    JobStatus.printing:  {JobStatus.done, JobStatus.failed},
    JobStatus.done:      set(),
    JobStatus.failed:    set(),
    JobStatus.expired:   set(),
    JobStatus.cancelled: set(),
}


@dataclass
class Job:
    job_id:     str
    machine_id: str
    filename:   str
    status:     JobStatus = JobStatus.created
    created_at: float = field(default_factory=time.monotonic)

    # after slicing
    grams:   float | None = None
    minutes: float | None = None
    slicer_error: str | None = None

    # after quote (pricing snapshot)
    quote: PriceQuote | None = None

    # after checkout (x402 order)
    order_id:   str      | None = None
    arc26_uri:  str      | None = None
    expires_at: float    | None = None   # monotonic
    tx_id:      str      | None = None
    refund_tx_id: str    | None = None

    # during/after print
    progress:   float | None = None   # 0.0–1.0
    print_error: str  | None = None

    def is_terminal(self) -> bool:
        return self.status in {
            JobStatus.done, JobStatus.failed,
            JobStatus.expired, JobStatus.cancelled,
        }

    def transition(self, new_status: JobStatus) -> None:
        allowed = _ALLOWED.get(self.status, set())
        if new_status not in allowed:
            raise ValueError(
                f"Job {self.job_id}: invalid transition "
                f"{self.status} → {new_status}"
            )
        self.status = new_status

    def check_expiry(self) -> None:
        """Expire checkout if payment window passed."""
        if (
            self.status == JobStatus.checkout
            and self.expires_at is not None
            and time.monotonic() > self.expires_at
        ):
            self.status = JobStatus.expired

    def to_dict(self) -> dict[str, Any]:
        self.check_expiry()
        d: dict[str, Any] = {
            "job_id":     self.job_id,
            "machine_id": self.machine_id,
            "filename":   self.filename,
            "status":     self.status.value,
        }
        if self.grams is not None:
            d["grams"]   = self.grams
            d["minutes"] = self.minutes
        if self.quote is not None:
            d["price"] = self.quote.to_dict()
        if self.order_id is not None:
            d["payment"] = {
                "order_id":    self.order_id,
                "arc26_uri":   self.arc26_uri,
                "expires_at":  self.expires_at,
                "tx_id":       self.tx_id,
                "refund_tx_id": self.refund_tx_id,
            }
        if self.progress is not None:
            d["progress"] = self.progress
        if self.slicer_error:
            d["error"] = self.slicer_error
        if self.print_error:
            d["error"] = self.print_error
        return d


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}

    def create(self, machine_id: str, filename: str) -> Job:
        job_id = f"j_{uuid4().hex[:12]}"
        job = Job(job_id=job_id, machine_id=machine_id, filename=filename)
        self._jobs[job_id] = job
        return job

    def get(self, job_id: str) -> Job | None:
        job = self._jobs.get(job_id)
        if job:
            job.check_expiry()
        return job

    def require(self, job_id: str) -> Job:
        job = self.get(job_id)
        if job is None:
            raise KeyError(f"Job not found: {job_id}")
        return job

    def set_slicing_result(
        self,
        job_id: str,
        grams: float,
        minutes: float,
        quote: PriceQuote,
    ) -> Job:
        job = self.require(job_id)
        job.transition(JobStatus.quoted)
        job.grams   = grams
        job.minutes = minutes
        job.quote   = quote
        return job

    def set_slicing_failed(self, job_id: str, error: str) -> Job:
        job = self.require(job_id)
        job.transition(JobStatus.failed)
        job.slicer_error = error
        return job

    def set_checkout(
        self,
        job_id: str,
        order_id: str,
        arc26_uri: str,
        ttl_seconds: float,
    ) -> Job:
        job = self.require(job_id)
        job.transition(JobStatus.checkout)
        job.order_id   = order_id
        job.arc26_uri  = arc26_uri
        job.expires_at = time.monotonic() + ttl_seconds
        return job

    def set_paid(self, job_id: str, tx_id: str) -> Job:
        job = self.require(job_id)
        job.transition(JobStatus.paid)
        job.tx_id = tx_id
        return job

    def set_refunded(self, job_id: str, refund_tx_id: str) -> Job:
        job = self.require(job_id)
        job.refund_tx_id = refund_tx_id
        return job

    def set_printing(self, job_id: str) -> Job:
        job = self.require(job_id)
        job.transition(JobStatus.printing)
        return job

    def set_progress(self, job_id: str, progress: float) -> Job:
        job = self.require(job_id)
        job.progress = max(0.0, min(1.0, progress))
        return job

    def set_done(self, job_id: str) -> Job:
        job = self.require(job_id)
        job.transition(JobStatus.done)
        return job

    def set_failed(self, job_id: str, error: str) -> Job:
        job = self.require(job_id)
        job.transition(JobStatus.failed)
        job.print_error = error
        return job

    def cancel(self, job_id: str) -> Job:
        job = self.require(job_id)
        job.transition(JobStatus.cancelled)
        return job

    def by_machine(self, machine_id: str) -> list[Job]:
        return [j for j in self._jobs.values() if j.machine_id == machine_id]

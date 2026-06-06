import time
import pytest
from decimal import Decimal
from src.jobs import Job, JobStatus, JobStore, _ALLOWED
from src.exchange import RateSnapshot
from src.pricing import compute_quote, PriceQuote
from src.config import PriceConfig

RATE = RateSnapshot(eur_per_usd=Decimal("0.916"), fetched_at=0.0)
CFG  = PriceConfig()


def make_quote(grams=50.0, minutes=120.0) -> PriceQuote:
    return compute_quote(grams, minutes, RATE, CFG)


class TestTransitions:
    def test_happy_path(self):
        store = JobStore()
        job = store.create("pi_001", "benchy.stl")
        assert job.status == JobStatus.created

        job.transition(JobStatus.slicing)
        store.set_slicing_result(job.job_id, 12.4, 47.0, make_quote(12.4, 47.0))
        assert job.status == JobStatus.quoted

        store.set_checkout(job.job_id, "order_abc", "algorand://...", ttl_seconds=900)
        assert job.status == JobStatus.checkout

        store.set_paid(job.job_id, "TX123")
        assert job.status == JobStatus.paid
        assert job.tx_id == "TX123"

        store.set_printing(job.job_id)
        store.set_progress(job.job_id, 0.47)
        assert job.progress == 0.47

        store.set_done(job.job_id)
        assert job.status == JobStatus.done
        assert job.is_terminal()

    def test_invalid_transition_raises(self):
        job = Job(job_id="j_1", machine_id="pi", filename="f.stl")
        with pytest.raises(ValueError, match="invalid transition"):
            job.transition(JobStatus.done)

    def test_all_transitions_are_defined(self):
        for status in JobStatus:
            assert status in _ALLOWED

    def test_terminal_statuses_have_no_transitions(self):
        for s in (JobStatus.done, JobStatus.failed, JobStatus.expired, JobStatus.cancelled):
            assert _ALLOWED[s] == set()

    def test_slicing_failure(self):
        store = JobStore()
        job = store.create("pi", "broken.stl")
        job.transition(JobStatus.slicing)
        store.set_slicing_failed(job.job_id, "slicer crashed")
        assert job.status == JobStatus.failed
        assert job.slicer_error == "slicer crashed"
        assert job.is_terminal()

    def test_cancel_from_quoted(self):
        store = JobStore()
        job = store.create("pi", "f.stl")
        job.transition(JobStatus.slicing)
        store.set_slicing_result(job.job_id, 10.0, 30.0, make_quote(10.0, 30.0))
        store.cancel(job.job_id)
        assert job.status == JobStatus.cancelled

    def test_cancel_from_checkout(self):
        store = JobStore()
        job = store.create("pi", "f.stl")
        job.transition(JobStatus.slicing)
        store.set_slicing_result(job.job_id, 10.0, 30.0, make_quote())
        store.set_checkout(job.job_id, "o_1", "uri", 900)
        store.cancel(job.job_id)
        assert job.status == JobStatus.cancelled

    def test_cannot_cancel_after_paid(self):
        store = JobStore()
        job = store.create("pi", "f.stl")
        job.transition(JobStatus.slicing)
        store.set_slicing_result(job.job_id, 10.0, 30.0, make_quote())
        store.set_checkout(job.job_id, "o_1", "uri", 900)
        store.set_paid(job.job_id, "TX1")
        with pytest.raises(ValueError):
            store.cancel(job.job_id)


class TestExpiry:
    def test_expires_when_ttl_passed(self, monkeypatch):
        store = JobStore()
        job = store.create("pi", "f.stl")
        job.transition(JobStatus.slicing)
        store.set_slicing_result(job.job_id, 10.0, 30.0, make_quote())
        store.set_checkout(job.job_id, "o_1", "uri", ttl_seconds=10)

        monkeypatch.setattr(time, "monotonic", lambda: job.expires_at + 1)
        job.check_expiry()
        assert job.status == JobStatus.expired

    def test_does_not_expire_before_ttl(self, monkeypatch):
        store = JobStore()
        job = store.create("pi", "f.stl")
        job.transition(JobStatus.slicing)
        store.set_slicing_result(job.job_id, 10.0, 30.0, make_quote())
        store.set_checkout(job.job_id, "o_1", "uri", ttl_seconds=900)
        job.check_expiry()
        assert job.status == JobStatus.checkout

    def test_get_triggers_expiry_check(self, monkeypatch):
        store = JobStore()
        job = store.create("pi", "f.stl")
        job.transition(JobStatus.slicing)
        store.set_slicing_result(job.job_id, 10.0, 30.0, make_quote())
        store.set_checkout(job.job_id, "o_1", "uri", ttl_seconds=10)

        monkeypatch.setattr(time, "monotonic", lambda: job.expires_at + 1)
        fetched = store.get(job.job_id)
        assert fetched.status == JobStatus.expired


class TestToDict:
    def test_created_minimal(self):
        job = Job(job_id="j_1", machine_id="pi", filename="f.stl")
        d = job.to_dict()
        assert d["status"] == "created"
        assert "grams" not in d
        assert "price" not in d
        assert "payment" not in d

    def test_quoted_includes_price(self):
        store = JobStore()
        job = store.create("pi", "f.stl")
        job.transition(JobStatus.slicing)
        store.set_slicing_result(job.job_id, 50.0, 120.0, make_quote(50.0, 120.0))
        d = job.to_dict()
        assert d["status"] == "quoted"
        assert d["grams"] == 50.0
        assert "price" in d
        assert "eur_amount" in d["price"]
        assert "usdc_amount" in d["price"]

    def test_checkout_includes_payment(self):
        store = JobStore()
        job = store.create("pi", "f.stl")
        job.transition(JobStatus.slicing)
        store.set_slicing_result(job.job_id, 10.0, 30.0, make_quote())
        store.set_checkout(job.job_id, "order_xyz", "algorand://...", 900)
        d = job.to_dict()
        assert d["payment"]["order_id"] == "order_xyz"
        assert d["payment"]["arc26_uri"] == "algorand://..."


class TestJobStore:
    def test_create_and_get(self):
        store = JobStore()
        job = store.create("pi_001", "cat.stl")
        assert store.get(job.job_id) is job

    def test_get_missing_returns_none(self):
        assert JobStore().get("nope") is None

    def test_require_missing_raises(self):
        with pytest.raises(KeyError):
            JobStore().require("nope")

    def test_progress_clamp(self):
        store = JobStore()
        job = store.create("pi", "f.stl")
        job.transition(JobStatus.slicing)
        store.set_slicing_result(job.job_id, 1.0, 1.0, make_quote(1.0, 1.0))
        store.set_checkout(job.job_id, "o", "u", 900)
        store.set_paid(job.job_id, "TX")
        store.set_printing(job.job_id)
        store.set_progress(job.job_id, 1.5)
        assert job.progress == 1.0
        store.set_progress(job.job_id, -0.1)
        assert job.progress == 0.0

    def test_by_machine(self):
        store = JobStore()
        j1 = store.create("pi_A", "a.stl")
        j2 = store.create("pi_A", "b.stl")
        store.create("pi_B", "c.stl")
        result = store.by_machine("pi_A")
        assert {j.job_id for j in result} == {j1.job_id, j2.job_id}

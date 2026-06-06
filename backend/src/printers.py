"""
Offer aggregator — collects real quotes from registered printer servers.

This replaces the hard-coded mock offers. For a sliced job the marketplace
talks to every printer listed in the ``PRINTERS`` env var and merges three
responses into a single offer per printer:

  1. GET  /info            → static metadata (name, location, capabilities)
  2. POST /quote           → availability (can_start_at) + payment_url
  3. GET  {payment_url}     → 402 Payment Required; the x402 body carries the
                              authoritative price (amount, asset, payTo)

A printer that fails (unreachable, bad response, no 402) is skipped and logged
so one dead printer never blocks the whole marketplace. Printers are queried
concurrently.

See architecture.md §2–3 for the full flow.
"""

import asyncio
import logging
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from typing import Any

import httpx

from .exchange import RateSnapshot

log = logging.getLogger(__name__)

EUR_PLACES = Decimal("0.01")
MICRO_USDC = Decimal("1000000")


@dataclass(frozen=True)
class JobRequest:
    """The sliced job the marketplace broadcasts to printers."""
    job_id: str
    grams: float
    minutes: float
    gcode_url: str

    def quote_body(self) -> dict[str, Any]:
        return {
            "job_id":    self.job_id,
            "grams":     self.grams,
            "minutes":   self.minutes,
            "gcode_url": self.gcode_url,
        }


@dataclass(frozen=True)
class PaymentRequirement:
    """Authoritative payment details parsed from the printer's 402 response."""
    scheme:  str
    network: str
    address: str            # payTo
    amount:  int            # micro-USDC (atomic units)
    asset:   int | None
    nonce:   str | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "scheme":  self.scheme,
            "network": self.network,
            "address": self.address,
            "amount":  self.amount,
            "asset":   self.asset,
            "nonce":   self.nonce,
        }


@dataclass(frozen=True)
class PrinterOffer:
    """One printer's complete offer: /info + /quote + 402 price, merged."""
    printer_id:   str
    name:         str
    location:     dict[str, Any]
    capabilities: dict[str, Any]
    can_start_at: str
    payment_url:  str
    payment:      PaymentRequirement
    price_usdc:   Decimal
    price_eur:    Decimal | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "printer_id":       self.printer_id,
            "name":             self.name,
            "location":         self.location,
            "capabilities":     self.capabilities,
            "can_start_at":     self.can_start_at,
            "payment_url":      self.payment_url,
            "payment_required": self.payment.to_dict(),
            "price_usdc":       f"{self.price_usdc:.6f}",
            "price_eur":        f"{self.price_eur:.2f}" if self.price_eur is not None else None,
        }


def _parse_payment_requirement(body: dict[str, Any]) -> PaymentRequirement:
    """Parse an x402 ``402 Payment Required`` JSON body.

    Body shape (x402 v1):
        {"x402Version": 1, "error": "...", "accepts": [ <requirement>, ... ]}
    """
    accepts = body.get("accepts") or []
    if not accepts:
        raise ValueError("402 body has no 'accepts' entries")

    req = accepts[0]
    extra = req.get("extra") or {}

    raw_amount = req.get("maxAmountRequired", req.get("amount"))
    if raw_amount is None:
        raise ValueError("402 requirement has no amount")
    amount = int(Decimal(str(raw_amount)))

    raw_asset = req.get("asset", extra.get("asset"))
    asset: int | None
    try:
        asset = int(raw_asset) if raw_asset is not None else None
    except (TypeError, ValueError):
        asset = None  # non-numeric asset id (e.g. EVM address) — not used here

    return PaymentRequirement(
        scheme=str(req.get("scheme", "")),
        network=str(req.get("network", "")),
        address=str(req.get("payTo", req.get("address", ""))),
        amount=amount,
        asset=asset,
        nonce=extra.get("nonce") or req.get("nonce"),
    )


async def _fetch_payment_requirement(
    client: httpx.AsyncClient, payment_url: str
) -> PaymentRequirement:
    """GET the payment URL unauthenticated; expect a 402 with price metadata."""
    resp = await client.get(payment_url)
    if resp.status_code != 402:
        raise ValueError(
            f"expected 402 from {payment_url}, got {resp.status_code}"
        )
    return _parse_payment_requirement(resp.json())


async def _build_offer(
    client: httpx.AsyncClient,
    base_url: str,
    job: JobRequest,
    rate: RateSnapshot | None,
) -> tuple[PrinterOffer | None, dict[str, str] | None]:
    """Run /info → /quote → 402 for one printer.

    Returns ``(offer, None)`` on success or ``(None, error_dict)`` on failure so
    the caller can surface connection problems to the user instead of silently
    dropping them.
    """
    try:
        info_resp = await client.get(f"{base_url}/info")
        info_resp.raise_for_status()
        info = info_resp.json()

        quote_resp = await client.post(f"{base_url}/quote", json=job.quote_body())
        quote_resp.raise_for_status()
        quote = quote_resp.json()

        payment_url = quote.get("payment_url")
        if not payment_url:
            raise ValueError("quote response missing payment_url")

        payment = await _fetch_payment_requirement(client, payment_url)
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        log.warning("printer %s skipped: %s", base_url, exc)
        return None, {"url": base_url, "error": str(exc)}

    price_usdc = (Decimal(payment.amount) / MICRO_USDC)
    price_eur = (
        rate.usdc_to_eur(price_usdc).quantize(EUR_PLACES, rounding=ROUND_HALF_UP)
        if rate is not None
        else None
    )

    return PrinterOffer(
        printer_id=str(info.get("printer_id", "")),
        name=str(info.get("name", info.get("printer_id", "unknown"))),
        location=info.get("location") or {},
        capabilities=info.get("capabilities") or {},
        can_start_at=str(quote.get("can_start_at", "")),
        payment_url=payment_url,
        payment=payment,
        price_usdc=price_usdc,
        price_eur=price_eur,
    ), None


@dataclass(frozen=True)
class CollectResult:
    """Outcome of a batch collect_offers call."""
    offers: list[PrinterOffer]
    errors: list[dict[str, str]]   # [{"url": "...", "error": "..."}, ...]


async def collect_offers(
    printer_urls: tuple[str, ...] | list[str],
    job: JobRequest,
    rate: RateSnapshot | None = None,
    timeout: float = 8.0,
) -> CollectResult:
    """Query all printers concurrently; return successful offers and any errors."""
    if not printer_urls:
        log.warning("no printers configured (set the PRINTERS env var)")
        return CollectResult(offers=[], errors=[])

    async with httpx.AsyncClient(timeout=timeout) as client:
        pairs = await asyncio.gather(
            *(_build_offer(client, url, job, rate) for url in printer_urls)
        )

    offers = [offer for offer, _ in pairs if offer is not None]
    errors = [err for _, err in pairs if err is not None]
    return CollectResult(offers=offers, errors=errors)

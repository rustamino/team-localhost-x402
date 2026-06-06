"""
Offer aggregator — collects real quotes from connected printer servers.

Printers register via WebSocket (/ws/printer) and are kept in the
printer_registry. For a sliced job the marketplace fans out three
steps to every connected printer over the same WS channel:

  1. GET  /info            → static metadata (name, location, capabilities)
  2. POST /quote           → availability (can_start_at) + local payment path
  3. GET  /pay/{job_id}   → 402; PAYMENT-REQUIRED header carries price metadata

The public payment_url in each offer points to the backend proxy route
(/printer/{printer_id}/pay/{job_id}), which tunnels over WebSocket when
the payer later sends an X-PAYMENT proof.

A printer that fails (disconnected, bad response, timeout) is skipped and
logged — one dead printer never blocks the whole marketplace.
"""

import asyncio
import base64
import json
import logging
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from typing import Any

from .exchange import RateSnapshot
from .printer_registry import PrinterConnection

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
        asset = None

    return PaymentRequirement(
        scheme=str(req.get("scheme", "")),
        network=str(req.get("network", "")),
        address=str(req.get("payTo", req.get("address", ""))),
        amount=amount,
        asset=asset,
        nonce=extra.get("nonce") or req.get("nonce"),
    )


def _parse_402_ws_response(resp: dict[str, Any]) -> PaymentRequirement:
    """Extract payment requirement from a tunnelled 402 response dict.

    x402 v2: requirements in PAYMENT-REQUIRED header (base64 JSON).
    x402 v1 fallback: requirements in body.
    """
    hdrs = {k.lower(): v for k, v in (resp.get("headers") or {}).items()}
    header = hdrs.get("payment-required")
    if header:
        try:
            body = json.loads(base64.b64decode(header))
        except Exception as exc:
            raise ValueError(f"malformed PAYMENT-REQUIRED header: {exc}") from exc
    else:
        body = resp.get("body") or {}
    return _parse_payment_requirement(body)


async def _build_offer(
    conn: PrinterConnection,
    job: JobRequest,
    proxy_base_url: str,
    rate: RateSnapshot | None,
    timeout: float,
) -> tuple[PrinterOffer | None, dict[str, str] | None]:
    """Run /info → /quote → /pay/{id} over WebSocket for one printer.

    Returns (offer, None) on success or (None, error_dict) on failure.
    """
    try:
        info_resp = await conn.request("GET", "/info", timeout=timeout)
        if info_resp["status"] != 200:
            raise ValueError(f"/info returned {info_resp['status']}")
        info = info_resp["body"]

        quote_resp = await conn.request("POST", "/quote", body=job.quote_body(), timeout=timeout)
        if quote_resp["status"] != 200:
            raise ValueError(f"/quote returned {quote_resp['status']}: {quote_resp.get('body')}")
        quote = quote_resp["body"]

        # Fetch the 402 over WS to extract payment metadata for the offer card.
        # The proxy payment URL will be used by the payer for the actual payment.
        pay_resp = await conn.request("GET", f"/pay/{job.job_id}", timeout=timeout)
        if pay_resp["status"] != 402:
            raise ValueError(
                f"expected 402 from /pay/{job.job_id}, got {pay_resp['status']}"
            )
        payment = _parse_402_ws_response(pay_resp)

    except (ValueError, KeyError, asyncio.TimeoutError) as exc:
        log.warning("printer %s skipped: %s", conn.printer_id, exc)
        return None, {"printer_id": conn.printer_id, "error": str(exc)}

    # Payment URL points to the backend proxy (/printer/{id}/pay/{job_id}),
    # which tunnels the payer's X-PAYMENT request back to this printer over WS.
    proxy_payment_url = f"{proxy_base_url}/printer/{conn.printer_id}/pay/{job.job_id}"

    price_usdc = Decimal(payment.amount) / MICRO_USDC
    price_eur = (
        rate.usdc_to_eur(price_usdc).quantize(EUR_PLACES, rounding=ROUND_HALF_UP)
        if rate is not None
        else None
    )

    return PrinterOffer(
        printer_id=str(info.get("printer_id", conn.printer_id)),
        name=str(info.get("name", info.get("printer_id", "unknown"))),
        location=info.get("location") or {},
        capabilities=info.get("capabilities") or {},
        can_start_at=str(quote.get("can_start_at", "")),
        payment_url=proxy_payment_url,
        payment=payment,
        price_usdc=price_usdc,
        price_eur=price_eur,
    ), None


@dataclass(frozen=True)
class CollectResult:
    """Outcome of a batch collect_offers call."""
    offers: list[PrinterOffer]
    errors: list[dict[str, str]]


async def collect_offers(
    connections: list[PrinterConnection],
    job: JobRequest,
    proxy_base_url: str,
    rate: RateSnapshot | None = None,
    timeout: float = 8.0,
) -> CollectResult:
    """Query all connected printers concurrently; return offers and errors."""
    if not connections:
        log.warning("no printers connected")
        return CollectResult(offers=[], errors=[])

    pairs = await asyncio.gather(
        *(_build_offer(conn, job, proxy_base_url, rate, timeout) for conn in connections)
    )

    offers = [offer for offer, _ in pairs if offer is not None]
    errors = [err for _, err in pairs if err is not None]
    return CollectResult(offers=offers, errors=errors)

import asyncio
from decimal import Decimal

import httpx
import pytest

from src.exchange import RateSnapshot
from src.printers import (
    JobRequest,
    PrinterOffer,
    _parse_payment_requirement,
    collect_offers,
)
from src.selection import select_offer

RATE_0916 = RateSnapshot(eur_per_usd=Decimal("0.9160"), fetched_at=0.0)

JOB = JobRequest(
    job_id="j_abc123",
    grams=12.4,
    minutes=47,
    gcode_url="https://marketplace.example.com/files/j_abc123.gcode",
)

INFO = {
    "printer_id": "printer_42",
    "name": "BerlinMaker FDM-1",
    "location": {"lat": 52.52, "lon": 13.40, "city": "Berlin"},
    "capabilities": {"materials": ["PLA", "PETG"], "max_volume_cm3": 400},
}

QUOTE = {
    "can_start_at": "2026-06-06T15:00:00Z",
    "payment_url": "http://printer/pay/j_abc123",
}

PAYMENT_402 = {
    "x402Version": 1,
    "error": "X-PAYMENT header is required",
    "accepts": [
        {
            "scheme": "exact",
            "network": "algorand-testnet",
            "maxAmountRequired": "670000",
            "asset": "10458941",
            "payTo": "BERLINMAKERADDRESS",
            "extra": {"asset": 10458941},
        }
    ],
}


def _handler(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path == "/info":
        return httpx.Response(200, json=INFO)
    if path == "/quote":
        return httpx.Response(200, json=QUOTE)
    if path == "/pay/j_abc123":
        return httpx.Response(402, json=PAYMENT_402)
    return httpx.Response(404)


class TestParsePaymentRequirement:
    def test_parses_amount_asset_address(self):
        pr = _parse_payment_requirement(PAYMENT_402)
        assert pr.amount == 670000
        assert pr.asset == 10458941
        assert pr.address == "BERLINMAKERADDRESS"
        assert pr.scheme == "exact"

    def test_no_accepts_raises(self):
        with pytest.raises(ValueError):
            _parse_payment_requirement({"x402Version": 1, "accepts": []})


class TestCollectOffers:
    def test_merges_info_quote_and_402(self, monkeypatch):
        transport = httpx.MockTransport(_handler)
        real_client = httpx.AsyncClient

        def patched_client(*args, **kwargs):
            kwargs["transport"] = transport
            return real_client(*args, **kwargs)

        monkeypatch.setattr(httpx, "AsyncClient", patched_client)

        offers = asyncio.run(collect_offers(("http://printer",), JOB, RATE_0916))

        assert len(offers) == 1
        offer = offers[0]
        assert isinstance(offer, PrinterOffer)
        assert offer.printer_id == "printer_42"
        assert offer.name == "BerlinMaker FDM-1"
        assert offer.location["city"] == "Berlin"
        assert offer.can_start_at == "2026-06-06T15:00:00Z"
        assert offer.payment_url == "http://printer/pay/j_abc123"
        assert offer.price_usdc == Decimal("0.670000")
        # 0.67 USDC × 0.9160 ≈ 0.61 EUR
        assert offer.price_eur == Decimal("0.61")

    def test_skips_failing_printer(self, monkeypatch):
        def failing_handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500)

        transport = httpx.MockTransport(failing_handler)
        real_client = httpx.AsyncClient
        monkeypatch.setattr(
            httpx,
            "AsyncClient",
            lambda *a, **k: real_client(*a, **{**k, "transport": transport}),
        )

        offers = asyncio.run(collect_offers(("http://printer",), JOB, RATE_0916))
        assert offers == []

    def test_no_printers_returns_empty(self):
        assert asyncio.run(collect_offers((), JOB, RATE_0916)) == []


class TestSelectOffer:
    def test_picks_index_zero(self):
        offer = PrinterOffer(
            printer_id="p1",
            name="P1",
            location={},
            capabilities={},
            can_start_at="",
            payment_url="",
            payment=_parse_payment_requirement(PAYMENT_402),
            price_usdc=Decimal("0.67"),
            price_eur=Decimal("0.73"),
        )
        decision = select_offer([offer, offer])
        assert decision.selected_index == 0

    def test_empty_offers_returns_none(self):
        decision = select_offer([])
        assert decision.selected_index is None

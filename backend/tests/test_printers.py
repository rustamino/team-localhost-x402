import asyncio
import json
from decimal import Decimal

import httpx
import pytest

from src.exchange import RateSnapshot
from src.printers import (
    CollectResult,
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

        result = asyncio.run(collect_offers(("http://printer",), JOB, RATE_0916))

        assert isinstance(result, CollectResult)
        assert len(result.offers) == 1
        assert result.errors == []
        offer = result.offers[0]
        assert isinstance(offer, PrinterOffer)
        assert offer.printer_id == "printer_42"
        assert offer.name == "BerlinMaker FDM-1"
        assert offer.location["city"] == "Berlin"
        assert offer.can_start_at == "2026-06-06T15:00:00Z"
        assert offer.payment_url == "http://printer/pay/j_abc123"
        assert offer.price_usdc == Decimal("0.670000")
        # 0.67 USDC × 0.9160 ≈ 0.61 EUR
        assert offer.price_eur == Decimal("0.61")

    def test_skips_failing_printer_and_reports_error(self, monkeypatch):
        def failing_handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500)

        transport = httpx.MockTransport(failing_handler)
        real_client = httpx.AsyncClient
        monkeypatch.setattr(
            httpx,
            "AsyncClient",
            lambda *a, **k: real_client(*a, **{**k, "transport": transport}),
        )

        result = asyncio.run(collect_offers(("http://printer",), JOB, RATE_0916))
        assert isinstance(result, CollectResult)
        assert result.offers == []
        assert len(result.errors) == 1
        assert result.errors[0]["url"] == "http://printer"
        assert result.errors[0]["error"]  # non-empty error message

    def test_no_printers_returns_empty(self):
        result = asyncio.run(collect_offers((), JOB, RATE_0916))
        assert isinstance(result, CollectResult)
        assert result.offers == []
        assert result.errors == []


def _make_offer() -> PrinterOffer:
    return PrinterOffer(
        printer_id="p1",
        name="P1",
        location={"city": "Berlin"},
        capabilities={},
        can_start_at="",
        payment_url="",
        payment=_parse_payment_requirement(PAYMENT_402),
        price_usdc=Decimal("0.67"),
        price_eur=Decimal("0.73"),
    )


def _openai_response(selected_index, confidence="high", reason="picked") -> dict:
    """Build a minimal OpenAI Responses API payload carrying the JSON result."""
    payload = {
        "selected_index": selected_index,
        "confidence": confidence,
        "reason": reason,
    }
    return {
        "output": [
            {
                "content": [
                    {"type": "output_text", "text": json.dumps(payload)},
                ]
            }
        ]
    }


def _patch_openai(monkeypatch, response_json, status=200):
    """Make httpx.AsyncClient route OpenAI calls to a canned response."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "api.openai.com"
        return httpx.Response(status, json=response_json)

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda *a, **k: real_client(*a, **{**k, "transport": transport}),
    )


class TestSelectOffer:
    def test_picks_model_index(self, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        _patch_openai(monkeypatch, _openai_response(selected_index=1))

        offers = [_make_offer(), _make_offer()]
        decision = asyncio.run(select_offer(offers, "cheapest in Berlin"))

        assert decision.selected_index == 1
        assert decision.confidence == "high"
        assert decision.reasoning == "picked"

    def test_empty_offers_returns_none(self, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        decision = asyncio.run(select_offer([]))
        assert decision.selected_index is None
        assert decision.confidence == "low"

    def test_missing_api_key_raises(self, monkeypatch):
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        with pytest.raises(RuntimeError):
            asyncio.run(select_offer([_make_offer()]))

    def test_invalid_index_falls_back_to_none(self, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        _patch_openai(monkeypatch, _openai_response(selected_index=5))

        decision = asyncio.run(select_offer([_make_offer()]))
        assert decision.selected_index is None
        assert decision.confidence == "low"

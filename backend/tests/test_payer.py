import asyncio
import sys

import pytest

from src import payer as payer_mod
from src.payer import (
    PayerError,
    PaymentResult,
    _extract_tx_id,
    _parse_payer_output,
    pay_offer,
)


def _fake_cmd(script: str):
    """Make the payer launch the test's Python interpreter instead of node/tsx."""
    return lambda: [sys.executable, "-c", script]


class TestParsePayerOutput:
    def test_picks_json_after_log_lines(self):
        out = '[payer] signer: ABC\n[payer] paying: http://x\n{"ok": true, "payer": "ABC"}\n'
        assert _parse_payer_output(out) == {"ok": True, "payer": "ABC"}

    def test_picks_last_json_when_multiple(self):
        out = '{"ok": false}\nstray trailing log\n{"ok": true}\n'
        assert _parse_payer_output(out) == {"ok": True}

    def test_no_json_raises(self):
        with pytest.raises(PayerError):
            _parse_payer_output("no json here\njust logs\n")


class TestExtractTxId:
    def test_top_level(self):
        assert _extract_tx_id({"txId": "TX1"}) == "TX1"

    def test_in_settle(self):
        assert _extract_tx_id({"settle": {"transaction": "TX2"}}) == "TX2"

    def test_nested_in_settle_value(self):
        assert _extract_tx_id({"settle": {"receipt": {"tx_hash": "TX3"}}}) == "TX3"

    def test_absent_returns_none(self):
        assert _extract_tx_id({"settle": {"foo": "bar"}}) is None

    def test_non_string_ignored(self):
        assert _extract_tx_id({"transaction": {"id": "x"}}) is None


class TestPayOffer:
    def test_rejects_non_http_url(self):
        with pytest.raises(PayerError):
            asyncio.run(pay_offer("ftp://nope/pay/j"))

    def test_runs_subprocess_and_parses_success(self, monkeypatch):
        # Use the test's Python interpreter as a stand-in "payer" so the test
        # needs no Node toolchain: it logs to stderr + prints JSON to stdout.
        script = (
            "import sys; "
            "sys.stderr.write('log line\\n'); "
            'print(\'{"ok": true, "payer": "PAYER1", "settle": {"txId": "TXOK"}, '
            '"resource": {"status": "paid"}}\')'
        )
        monkeypatch.setattr(payer_mod, "_payer_command", _fake_cmd(script))
        monkeypatch.setenv("X402_PAYER_DIR", ".")

        result = asyncio.run(pay_offer("http://printer/pay/j_abc"))

        assert isinstance(result, PaymentResult)
        assert result.ok is True
        assert result.payer == "PAYER1"
        assert result.tx_id == "TXOK"
        assert result.resource == {"status": "paid"}

    def test_subprocess_failure_returns_not_ok(self, monkeypatch):
        script = 'print(\'{"ok": false, "error": "boom"}\')'
        monkeypatch.setattr(payer_mod, "_payer_command", _fake_cmd(script))
        monkeypatch.setenv("X402_PAYER_DIR", ".")

        result = asyncio.run(pay_offer("http://printer/pay/j_abc"))

        assert result.ok is False
        assert result.error == "boom"

    def test_no_json_output_raises(self, monkeypatch):
        script = "import sys; sys.stderr.write('only stderr\\n')"
        monkeypatch.setattr(payer_mod, "_payer_command", _fake_cmd(script))
        monkeypatch.setenv("X402_PAYER_DIR", ".")

        with pytest.raises(PayerError):
            asyncio.run(pay_offer("http://printer/pay/j_abc"))

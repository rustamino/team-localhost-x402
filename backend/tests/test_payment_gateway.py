import json
from decimal import Decimal
from unittest.mock import patch, MagicMock
import urllib.error
import pytest
from src.payment_gateway import PaymentGateway, PaymentError, OrderResult, OrderStatus

GW = PaymentGateway("http://localhost:3402")

ORDER_RESPONSE = {
    "order_id": "order_abc123",
    "arc26_uri": "algorand://ADDR?amount=2565502&asset=10458941&note=order_abc123",
    "amount_usdc": "2.565502",
    "expires_at": "2026-06-06T11:00:00Z",
    "status": "pending",
    "tx_id": None,
    "refund_tx_id": None,
}


def mock_urlopen(response_body: dict, status: int = 200):
    cm = MagicMock()
    cm.__enter__ = lambda s: s
    cm.__exit__ = MagicMock(return_value=False)
    cm.read = lambda: json.dumps(response_body).encode()
    cm.status = status
    return cm


class TestCreateOrder:
    def test_success(self):
        with patch("urllib.request.urlopen", return_value=mock_urlopen(ORDER_RESPONSE)):
            result = GW.create_order("j_abc", Decimal("2.565502"))
        assert isinstance(result, OrderResult)
        assert result.order_id == "order_abc123"
        assert result.amount_usdc == Decimal("2.565502")
        assert "algorand://" in result.arc26_uri

    def test_http_error_raises_payment_error(self):
        err = urllib.error.HTTPError(
            url="", code=500, msg="Internal Server Error",
            hdrs=None, fp=MagicMock(read=lambda: b'{"error":"oops"}'),
        )
        with patch("urllib.request.urlopen", side_effect=err):
            with pytest.raises(PaymentError, match="500"):
                GW.create_order("j_abc", Decimal("1.00"))

    def test_network_error_raises_payment_error(self):
        with patch("urllib.request.urlopen", side_effect=OSError("connection refused")):
            with pytest.raises(PaymentError, match="unreachable"):
                GW.create_order("j_abc", Decimal("1.00"))


class TestGetOrderStatus:
    def test_pending(self):
        with patch("urllib.request.urlopen", return_value=mock_urlopen(ORDER_RESPONSE)):
            status = GW.get_order_status("order_abc123")
        assert status.status == "pending"
        assert status.tx_id is None

    def test_paid(self):
        paid = {**ORDER_RESPONSE, "status": "paid", "tx_id": "TXABC"}
        with patch("urllib.request.urlopen", return_value=mock_urlopen(paid)):
            status = GW.get_order_status("order_abc123")
        assert status.status == "paid"
        assert status.tx_id == "TXABC"

    def test_not_found_raises(self):
        err = urllib.error.HTTPError(
            url="", code=404, msg="Not Found",
            hdrs=None, fp=MagicMock(read=lambda: b'{"error":"Order not found"}'),
        )
        with patch("urllib.request.urlopen", side_effect=err):
            with pytest.raises(PaymentError, match="404"):
                GW.get_order_status("order_missing")

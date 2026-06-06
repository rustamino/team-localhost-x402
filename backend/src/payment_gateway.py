"""
Payment gateway — thin HTTP client to the x402 TypeScript service.

Intentionally minimal: this layer will be replaced or restructured
when agentic x402 flow (client acting on behalf of user) is introduced.
"""

import json
import urllib.request
import urllib.error
from dataclasses import dataclass
from decimal import Decimal


class PaymentError(Exception):
    pass


@dataclass(frozen=True)
class OrderResult:
    order_id: str
    arc26_uri: str
    amount_usdc: Decimal
    expires_at: str          # ISO-8601 from x402 service


@dataclass(frozen=True)
class OrderStatus:
    status: str              # pending | paid | overpaid | expired | cancelled
    tx_id: str | None
    refund_tx_id: str | None


class PaymentGateway:
    def __init__(self, base_url: str, timeout: float = 10.0) -> None:
        self._base = base_url.rstrip("/")
        self._timeout = timeout

    def _post(self, path: str, body: dict) -> dict:
        data = json.dumps(body).encode()
        req = urllib.request.Request(
            f"{self._base}{path}",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            raise PaymentError(f"x402 service {e.code}: {detail}") from e
        except OSError as e:
            raise PaymentError(f"x402 service unreachable: {e}") from e

    def _get(self, path: str) -> dict:
        req = urllib.request.Request(f"{self._base}{path}", method="GET")
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            raise PaymentError(f"x402 service {e.code}: {detail}") from e
        except OSError as e:
            raise PaymentError(f"x402 service unreachable: {e}") from e

    def create_order(self, job_id: str, amount_usdc: Decimal) -> OrderResult:
        data = self._post("/orders", {
            "job_id": job_id,
            "amount_usdc": float(amount_usdc),
        })
        return OrderResult(
            order_id=data["order_id"],
            arc26_uri=data["arc26_uri"],
            amount_usdc=Decimal(data["amount_usdc"]),
            expires_at=data["expires_at"],
        )

    def get_order_status(self, order_id: str) -> OrderStatus:
        data = self._get(f"/orders/{order_id}")
        return OrderStatus(
            status=data["status"],
            tx_id=data.get("tx_id"),
            refund_tx_id=data.get("refund_tx_id"),
        )

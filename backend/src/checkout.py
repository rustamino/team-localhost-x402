"""
Checkout watcher.

Creates payment intents keyed by job_id, then polls the Algorand testnet
indexer for incoming USDC to the marketplace wallet.  On detection it
forwards the job to the printer via the x402 payer subprocess.

Intent lifecycle:  pending → paid → forwarded | error
"""

import asyncio
import base64
import json
import logging
import urllib.request
from dataclasses import dataclass
from typing import Any

log = logging.getLogger(__name__)

USDC_ASSET_ID = 10_458_941          # testnet USDC ASA
_INDEXER = "https://testnet-idx.algonode.cloud"
_NODE    = "https://testnet-api.algonode.cloud"


# ── data model ────────────────────────────────────────────────────────────────

@dataclass
class CheckoutIntent:
    checkout_id:       str           # == job_id
    job_id:            str
    amount_micro_usdc: int           # what the user must send
    payment_url:       str           # printer x402 proxy URL
    status:            str = "pending"   # pending|paid|forwarded|error
    user_tx_id:        str | None = None
    printer_tx_id:     str | None = None
    error:             str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "checkout_id":   self.checkout_id,
            "status":        self.status,
            "user_tx_id":    self.user_tx_id,
            "printer_tx_id": self.printer_tx_id,
            "error":         self.error,
        }


class CheckoutStore:
    def __init__(self) -> None:
        self._store: dict[str, CheckoutIntent] = {}

    def add(self, intent: CheckoutIntent) -> None:
        self._store[intent.checkout_id] = intent

    def get(self, checkout_id: str) -> CheckoutIntent | None:
        return self._store.get(checkout_id)

    def pending(self) -> list[CheckoutIntent]:
        return [i for i in self._store.values() if i.status == "pending"]


store = CheckoutStore()


# ── Algorand helpers (blocking — called via run_in_executor) ──────────────────

def _get_json(url: str) -> dict[str, Any]:
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def _current_round() -> int:
    try:
        return int(_get_json(f"{_NODE}/v2/status").get("last-round", 0))
    except Exception:
        return 0


def _fetch_txns(wallet: str, min_round: int) -> list[dict[str, Any]]:
    url = (
        f"{_INDEXER}/v2/accounts/{wallet}/transactions"
        f"?asset-id={USDC_ASSET_ID}&tx-type=axfer"
        f"&min-round={min_round}&limit=50"
    )
    try:
        return _get_json(url).get("transactions", [])
    except Exception as exc:
        log.warning("indexer error: %s", exc)
        return []


def _note_text(txn: dict) -> str:
    raw = txn.get("note", "")
    if not raw:
        return ""
    try:
        return base64.b64decode(raw).decode("utf-8", errors="replace").strip()
    except Exception:
        return ""


def _micro_usdc_received(txn: dict, receiver: str) -> int:
    pay = txn.get("asset-transfer-transaction", {})
    if pay.get("receiver") != receiver:
        return 0
    return int(pay.get("amount", 0))


# ── background watcher ────────────────────────────────────────────────────────

async def watch(marketplace_wallet: str, pay_offer_fn, poll_sec: float = 5.0) -> None:
    """Asyncio task: poll indexer, detect user payments, forward to printers."""
    loop = asyncio.get_event_loop()
    min_round = await loop.run_in_executor(None, _current_round)
    log.info(
        "checkout watcher started  wallet=…%s  round=%d",
        marketplace_wallet[-8:], min_round,
    )

    while True:
        await asyncio.sleep(poll_sec)
        pending = store.pending()
        if not pending:
            continue

        txns: list[dict] = await loop.run_in_executor(
            None, _fetch_txns, marketplace_wallet, min_round
        )
        for txn in txns:
            round_ = txn.get("confirmed-round", 0)
            if round_ > min_round:
                min_round = round_

            note     = _note_text(txn)
            received = _micro_usdc_received(txn, marketplace_wallet)
            if not note or not received:
                continue

            for intent in pending:
                if intent.status != "pending":
                    continue
                if note != intent.job_id:
                    continue
                if received < intent.amount_micro_usdc:
                    log.warning(
                        "job %s: received %d µUSDC < expected %d — ignoring",
                        intent.job_id, received, intent.amount_micro_usdc,
                    )
                    continue

                intent.status    = "paid"
                intent.user_tx_id = txn.get("id")
                log.info("job %s: user payment confirmed tx=%s", intent.job_id, intent.user_tx_id)
                asyncio.create_task(_forward(intent, pay_offer_fn))


async def _forward(intent: CheckoutIntent, pay_offer_fn) -> None:
    try:
        result = await pay_offer_fn(intent.payment_url)
        if result.ok:
            intent.status       = "forwarded"
            intent.printer_tx_id = result.tx_id
            log.info("job %s: printer paid tx=%s", intent.job_id, result.tx_id)
        else:
            intent.status = "error"
            intent.error  = result.error or "printer payment failed"
            log.error("job %s: printer payment error: %s", intent.job_id, intent.error)
    except Exception as exc:
        intent.status = "error"
        intent.error  = str(exc)
        log.error("job %s: forward exception: %s", intent.job_id, exc)

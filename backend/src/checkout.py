"""
Checkout watcher.

Creates payment intents keyed by job_id, then polls the Algorand testnet
indexer for incoming USDC to the marketplace wallet.  On detection it
forwards the job to the printer via the x402 payer subprocess.

Intent lifecycle:  pending → paid → forwarded | error
                   (pre-paid)   paid → forwarded | error

Persistence: SQLite (stdlib).  DB path from CHECKOUT_DB_PATH env var
(default: checkout.db) — survives uvicorn restarts.
"""

import asyncio
import base64
import json
import logging
import os
import sqlite3
import threading
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

USDC_ASSET_ID = 10_458_941          # testnet USDC ASA
_INDEXER = "https://testnet-idx.algonode.cloud"
_NODE    = "https://testnet-api.algonode.cloud"

_DB_PATH = Path(os.getenv("CHECKOUT_DB_PATH", "checkout.db"))


# ── data model ────────────────────────────────────────────────────────────────

@dataclass
class CheckoutIntent:
    checkout_id:       str           # == job_id
    job_id:            str
    amount_micro_usdc: int           # what the user must send / what is charged
    payment_url:       str           # printer x402 proxy URL
    status:            str = "pending"   # pending|paid|forwarded|error
    user_address:      str | None = None  # payer's Algorand address (from txn sender)
    user_tx_id:        str | None = None
    printer_tx_id:     str | None = None
    error:             str | None = None
    user_id:           str | None = None  # human-readable user identifier

    def to_dict(self) -> dict[str, Any]:
        return {
            "checkout_id":   self.checkout_id,
            "status":        self.status,
            "user_address":  self.user_address,
            "user_tx_id":    self.user_tx_id,
            "printer_tx_id": self.printer_tx_id,
            "error":         self.error,
            "user_id":       self.user_id,
        }


class CheckoutStore:
    """SQLite-backed checkout store — survives process restarts."""

    _CREATE = """
        CREATE TABLE IF NOT EXISTS checkouts (
            checkout_id       TEXT PRIMARY KEY,
            job_id            TEXT NOT NULL,
            amount_micro_usdc INTEGER NOT NULL,
            payment_url       TEXT NOT NULL,
            status            TEXT NOT NULL DEFAULT 'pending',
            user_address      TEXT,
            user_tx_id        TEXT,
            printer_tx_id     TEXT,
            error             TEXT,
            user_id           TEXT
        )
    """

    def __init__(self, db_path: Path = _DB_PATH) -> None:
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        with self._lock:
            self._conn.execute(self._CREATE)
            self._conn.commit()
            # Migration: add user_id column to existing databases
            try:
                self._conn.execute("ALTER TABLE checkouts ADD COLUMN user_id TEXT")
                self._conn.commit()
            except sqlite3.OperationalError:
                pass  # column already exists
        log.info("CheckoutStore opened: %s", db_path)

    # -- internal helpers -------------------------------------------------------

    def _row_to_intent(self, row: tuple) -> CheckoutIntent:
        return CheckoutIntent(
            checkout_id=row[0],
            job_id=row[1],
            amount_micro_usdc=row[2],
            payment_url=row[3],
            status=row[4],
            user_address=row[5],
            user_tx_id=row[6],
            printer_tx_id=row[7],
            error=row[8],
            user_id=row[9] if len(row) > 9 else None,
        )

    _SELECT = (
        "SELECT checkout_id, job_id, amount_micro_usdc, payment_url, "
        "status, user_address, user_tx_id, printer_tx_id, error, user_id "
        "FROM checkouts"
    )

    # -- public API -------------------------------------------------------------

    def add(self, intent: CheckoutIntent) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO checkouts "
                "(checkout_id, job_id, amount_micro_usdc, payment_url, status, "
                "user_address, user_tx_id, printer_tx_id, error, user_id) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    intent.checkout_id, intent.job_id, intent.amount_micro_usdc,
                    intent.payment_url, intent.status, intent.user_address,
                    intent.user_tx_id, intent.printer_tx_id, intent.error,
                    intent.user_id,
                ),
            )
            self._conn.commit()

    def get(self, checkout_id: str) -> CheckoutIntent | None:
        with self._lock:
            row = self._conn.execute(
                self._SELECT + " WHERE checkout_id = ?", (checkout_id,)
            ).fetchone()
        return self._row_to_intent(row) if row else None

    def update(self, intent: CheckoutIntent) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE checkouts "
                "SET status=?, user_address=?, user_tx_id=?, printer_tx_id=?, error=?, user_id=? "
                "WHERE checkout_id=?",
                (
                    intent.status, intent.user_address, intent.user_tx_id,
                    intent.printer_tx_id, intent.error, intent.user_id,
                    intent.checkout_id,
                ),
            )
            self._conn.commit()

    def pending(self) -> list[CheckoutIntent]:
        with self._lock:
            rows = self._conn.execute(
                self._SELECT + " WHERE status = 'pending'"
            ).fetchall()
        return [self._row_to_intent(row) for row in rows]

    def get_user_spent_micro(self, user_id: str) -> int:
        """Return total µUSDC reserved/spent for user_id (status != pending/error)."""
        with self._lock:
            row = self._conn.execute(
                "SELECT COALESCE(SUM(amount_micro_usdc), 0) FROM checkouts "
                "WHERE user_id = ? AND status NOT IN ('pending', 'error')",
                (user_id,),
            ).fetchone()
        return int(row[0]) if row else 0


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


def _fetch_txns(wallet: str, min_round: int, limit: int = 50) -> list[dict[str, Any]]:
    url = (
        f"{_INDEXER}/v2/accounts/{wallet}/transactions"
        f"?asset-id={USDC_ASSET_ID}&tx-type=axfer"
        f"&min-round={min_round}&limit={limit}"
    )
    try:
        return _get_json(url).get("transactions", [])
    except Exception as exc:
        log.warning("indexer error: %s", exc)
        return []


def _note_text(txn: dict) -> str:
    """Return the decoded note string from a transaction.

    Pera Wallet stores the ARC-26 `note` URI parameter verbatim instead of
    base64-decoding it first, so the note bytes are the base64-encoded user_id
    string rather than the raw user_id.  The indexer then base64-encodes those
    bytes again, resulting in double-encoding.  We try to decode twice and
    return the most deeply-decoded printable ASCII result.
    """
    raw = txn.get("note", "")
    if not raw:
        return ""
    try:
        decoded = base64.b64decode(raw).decode("utf-8", errors="replace").strip()
    except Exception:
        return ""
    # Attempt a second decode in case Pera stored the base64 string as-is
    try:
        decoded2 = base64.b64decode(decoded + "==").decode("utf-8", errors="replace").strip()
        if decoded2 and decoded2.isascii() and decoded2.isprintable():
            return decoded2
    except Exception:
        pass
    return decoded


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

                intent.user_address = txn.get("sender")
                intent.status       = "paid"
                intent.user_tx_id   = txn.get("id")
                store.update(intent)
                log.info(
                    "job %s: user payment confirmed tx=%s from %s",
                    intent.job_id, intent.user_tx_id,
                    (intent.user_address or "")[-8:],
                )
                asyncio.create_task(_forward(intent, pay_offer_fn))


async def _forward(intent: CheckoutIntent, pay_offer_fn) -> None:
    try:
        url = intent.payment_url
        if intent.user_address:
            sep = "&" if "?" in url else "?"
            url += sep + "user_address=" + urllib.parse.quote(intent.user_address, safe="")
        result = await pay_offer_fn(url)
        if result.ok:
            intent.status        = "forwarded"
            intent.printer_tx_id = result.tx_id
            store.update(intent)
            log.info("job %s: printer paid tx=%s", intent.job_id, result.tx_id)
        else:
            intent.status = "error"
            intent.error  = result.error or "printer payment failed"
            store.update(intent)
            log.error("job %s: printer payment error: %s", intent.job_id, intent.error)
    except Exception as exc:
        intent.status = "error"
        intent.error  = str(exc)
        store.update(intent)
        log.error("job %s: forward exception: %s", intent.job_id, exc)

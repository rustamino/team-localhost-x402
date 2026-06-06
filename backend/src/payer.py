"""
x402 payer bridge.

Pays a printer offer over the x402 protocol by shelling out to the standalone
TypeScript payer (``x402-payer/pay.ts``). The mnemonic that signs the payment
lives only in ``x402-payer/.env`` — see that folder's README. This is the
Pera-free path: the agent wallet signs programmatically instead of a human
scanning a QR in Pera Wallet.

The subprocess prints exactly one JSON result object on stdout; everything else
(its own logs, any library noise) goes to stderr.
"""

import asyncio
import json
import os
import shlex
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

_DEFAULT_PAYER_DIR = Path(__file__).parent.parent / "x402-payer"
# `node --import tsx` runs the TS file via a real node.exe — avoids the Windows
# headache of trying to exec npx.cmd / tsx.cmd directly from create_subprocess_exec.
_DEFAULT_CMD = "node --import tsx pay.ts"
_DEFAULT_TIMEOUT = 60.0

# Keys under which a settlement receipt might carry the on-chain tx id.
_TX_ID_KEYS = (
    "transaction",
    "txId",
    "txid",
    "tx_id",
    "txHash",
    "tx_hash",
    "txnId",
)


class PayerError(Exception):
    """The payer subprocess could not be launched or produced no usable result."""


@dataclass(frozen=True)
class PaymentResult:
    ok: bool
    payer: str | None = None
    tx_id: str | None = None
    settle: Any = None
    resource: Any = None
    error: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


def _payer_dir() -> Path:
    return Path(os.environ.get("X402_PAYER_DIR", str(_DEFAULT_PAYER_DIR)))


def _payer_command() -> list[str]:
    """Resolve the launch command (``X402_PAYER_CMD`` or the node+tsx default)."""
    raw = os.environ.get("X402_PAYER_CMD", _DEFAULT_CMD)
    # posix=False on Windows keeps backslashes in any path tokens intact.
    parts = shlex.split(raw, posix=os.name != "nt")
    if not parts:
        raise PayerError("X402_PAYER_CMD resolved to an empty command")
    exe = shutil.which(parts[0]) or parts[0]
    return [exe, *parts[1:]]


def _parse_payer_output(stdout: str) -> dict[str, Any]:
    """Return the JSON result object from the payer's stdout.

    The payer prints a single JSON line; we still scan from the end so any stray
    library output before it never breaks parsing.
    """
    for line in reversed([ln.strip() for ln in stdout.splitlines() if ln.strip()]):
        if line.startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    raise PayerError("payer produced no JSON result on stdout")


def _extract_tx_id(payload: dict[str, Any]) -> str | None:
    """Best-effort dig for an on-chain tx id in the payload / settle receipt."""
    candidates: list[dict[str, Any]] = [payload]
    settle = payload.get("settle")
    if isinstance(settle, dict):
        candidates.append(settle)
        candidates.extend(v for v in settle.values() if isinstance(v, dict))
    for obj in candidates:
        for key in _TX_ID_KEYS:
            val = obj.get(key)
            if isinstance(val, str) and val:
                return val
    return None


async def pay_offer(payment_url: str, timeout: float | None = None) -> PaymentResult:
    """Pay the given printer ``payment_url`` via the x402 payer subprocess.

    Raises ``PayerError`` if the payer can't be launched, times out, or emits no
    parseable result. A *settled-but-rejected* payment returns a ``PaymentResult``
    with ``ok=False`` and an ``error`` instead of raising.
    """
    if not payment_url or not payment_url.lower().startswith(("http://", "https://")):
        raise PayerError(f"invalid payment_url: {payment_url!r}")

    if timeout is None:
        timeout = float(os.environ.get("X402_PAYER_TIMEOUT", str(_DEFAULT_TIMEOUT)))

    cwd = _payer_dir()
    if not cwd.is_dir():
        raise PayerError(f"payer directory not found: {cwd}")

    cmd = [*_payer_command(), payment_url]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except OSError as exc:
        raise PayerError(f"failed to launch payer ({cmd[0]}): {exc}") from exc

    try:
        out_b, err_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError as exc:
        proc.kill()
        await proc.wait()
        raise PayerError(f"payer timed out after {timeout:.0f}s") from exc

    stdout = out_b.decode(errors="replace")
    stderr = err_b.decode(errors="replace")

    try:
        payload = _parse_payer_output(stdout)
    except PayerError:
        detail = stderr.strip() or stdout.strip() or "no output"
        raise PayerError(f"payer failed (exit {proc.returncode}): {detail}") from None

    return PaymentResult(
        ok=bool(payload.get("ok")),
        payer=payload.get("payer"),
        tx_id=_extract_tx_id(payload),
        settle=payload.get("settle"),
        resource=payload.get("resource"),
        error=payload.get("error"),
        raw=payload,
    )

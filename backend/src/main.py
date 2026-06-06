import logging
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.websockets import WebSocket, WebSocketDisconnect

from .config import AppConfig
from .exchange import ExchangeRateService
from .payer import PayerError, pay_offer
from .printer_registry import PrinterConnection, registry as printer_registry
from .printers import CollectResult, JobRequest, collect_offers
from .selection import Selection, select_offer

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

_DEFAULT_FRONTEND = Path(__file__).parent.parent.parent / "frontend"
FRONTEND_DIR = Path(os.getenv("FRONTEND_DIR", str(_DEFAULT_FRONTEND)))

config = AppConfig.from_env()
exchange = ExchangeRateService(ttl=config.rate_cache_ttl)

app = FastAPI(title="3D Print Marketplace")

# --- API routers go here (registered before static mount) ---
# app.include_router(jobs.router,     prefix="/api")
# app.include_router(search.router,   prefix="/api")


@app.websocket("/ws/printer")
async def printer_ws(ws: WebSocket) -> None:
    """Printer registration and request-relay endpoint.

    Printers connect here, authenticate with a token, and stay connected.
    The backend tunnels /info, /quote, and /pay/* requests over this channel.
    """
    await ws.accept()
    conn: PrinterConnection | None = None
    try:
        msg = await ws.receive_json()
        if msg.get("type") != "register":
            await ws.send_json({"type": "error", "message": "expected register message"})
            return

        token = msg.get("token", "")
        if token not in config.printer_tokens:
            await ws.send_json({"type": "error", "message": "invalid token"})
            return

        info = msg.get("info") or {}
        printer_id = str(info.get("printer_id") or token[:12])

        conn = PrinterConnection(printer_id=printer_id, info=info, ws=ws)
        printer_registry.register(conn)

        proxy_base = f"{config.public_base_url}/printer/{printer_id}"
        await ws.send_json({"type": "registered", "proxy_base_url": proxy_base})

        while True:
            try:
                msg = await ws.receive_json()
            except WebSocketDisconnect:
                break
            if msg.get("type") == "response":
                conn.resolve(msg.get("request_id", ""), msg)
            # pong and other message types are silently ignored

    except WebSocketDisconnect:
        pass
    finally:
        if conn:
            printer_registry.unregister(conn.printer_id)


@app.api_route("/printer/{printer_id}/pay/{job_id}", methods=["GET"])
async def proxy_printer_pay(printer_id: str, job_id: str, request: Request) -> JSONResponse:
    """Proxy the x402 payment handshake to the printer over WebSocket.

    The payer hits this URL twice:
      1. Without X-PAYMENT → printer returns 402 (route registered, not yet paid)
      2. With X-PAYMENT    → printer verifies on-chain via facilitator → 200
    """
    conn = printer_registry.get(printer_id)
    if conn is None:
        return JSONResponse({"error": "printer not connected"}, status_code=503)

    # Forward only the x402 payment headers; drop the rest
    forward: dict[str, str] = {}
    for h in ("x-payment", "payment-signature"):
        v = request.headers.get(h)
        if v:
            forward[h] = v

    try:
        resp = await conn.request(
            "GET", f"/pay/{job_id}",
            headers=forward or None,
            timeout=15.0,
        )
    except TimeoutError:
        return JSONResponse({"error": "printer timeout"}, status_code=504)

    status = resp.get("status", 500)
    body = resp.get("body") or {}
    # Forward x402 response headers (PAYMENT-REQUIRED, PAYMENT-RESPONSE, etc.)
    fwd_headers = {
        k: v for k, v in (resp.get("headers") or {}).items()
        if k.upper() in ("PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "CONTENT-TYPE")
    }
    return JSONResponse(content=body, status_code=status, headers=fwd_headers)


class OffersRequest(BaseModel):
    job_id: str
    grams: float
    minutes: float
    gcode_url: str
    instruction: str | None = None


@app.post("/api/offers")
async def offers(req: OffersRequest) -> dict:
    """Collect live quotes from every registered printer and pick the Agent's Pick.

    Replaces the hard-coded mock offers: fans out /info + /quote + 402 price
    discovery to all printers in the PRINTERS env var, then asks OpenAI to pick
    the best offer for the user's instruction (the "Agent's Pick").
    """
    job = JobRequest(
        job_id=req.job_id,
        grams=req.grams,
        minutes=req.minutes,
        gcode_url=req.gcode_url,
    )

    try:
        rate = exchange.get()
    except Exception:  # noqa: BLE001 — never block offers on a rate hiccup
        rate = None

    result: CollectResult = await collect_offers(
        printer_registry.all(), job, config.public_base_url, rate,
        timeout=config.printer_timeout,
    )

    try:
        decision = await select_offer(
            result.offers,
            req.instruction,
            openai_api_key=config.openai_api_key,
            model=config.openai_model,
        )
    except Exception as exc:  # noqa: BLE001 — never fail offers on a selection hiccup
        log.warning("agentic offer selection failed: %s", exc)
        decision = Selection(
            selected_index=None,
            confidence="low",
            reasoning=f"Agent's Pick unavailable: {exc}",
        )

    return {
        "offers":          [o.to_dict() for o in result.offers],
        "selected_index":  decision.selected_index,
        "confidence":      decision.confidence,
        "reasoning":       decision.reasoning,
        "printer_errors":  result.errors,   # [{url, error}] for each unreachable printer
    }


class PayRequest(BaseModel):
    # payment_url of the offer the user picked on the offers screen
    # (PrinterOffer.payment_url, the printer's x402-protected GET /pay/{job_id}).
    payment_url: str
    job_id: str | None = None


@app.post("/api/pay")
async def pay(req: PayRequest) -> dict:
    """Pay the selected printer offer over x402 (no Pera Wallet).

    Shells out to the TypeScript payer (``x402-payer/pay.ts``), which signs a
    USDC payment on Algorand testnet with the agent mnemonic and completes the
    402 → pay → retry handshake against the printer's ``payment_url``.
    """
    try:
        result = await pay_offer(req.payment_url)
    except PayerError as exc:
        log.warning("payer failed for %s: %s", req.payment_url, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    if not result.ok:
        raise HTTPException(
            status_code=402,
            detail=result.error or "payment was not settled",
        )

    return {
        "ok":       True,
        "job_id":   req.job_id,
        "payer":    result.payer,
        "tx_id":    result.tx_id,
        "settle":   result.settle,
        "resource": result.resource,
    }


# StaticFiles html=True resolves "/" → "index.html" but NOT "/admin" → "admin.html"
# (it would need "admin/index.html" for that). Explicit routes avoid the ambiguity.
@app.get("/admin", include_in_schema=False)
def admin_page() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "admin.html")

if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")


def serve() -> None:
    import uvicorn
    uvicorn.run("src.main:app", host="0.0.0.0", port=8000, reload=True)



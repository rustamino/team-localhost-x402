import logging
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .config import AppConfig
from .exchange import ExchangeRateService
from .payer import PayerError, pay_offer
from .printers import JobRequest, collect_offers
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

    collected = await collect_offers(
        config.printers, job, rate, timeout=config.printer_timeout
    )

    try:
        decision = await select_offer(
            collected,
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
        "offers":         [o.to_dict() for o in collected],
        "selected_index": decision.selected_index,
        "confidence":     decision.confidence,
        "reasoning":      decision.reasoning,
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



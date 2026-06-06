import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

_DEFAULT_FRONTEND = Path(__file__).parent.parent.parent / "frontend"
FRONTEND_DIR = Path(os.getenv("FRONTEND_DIR", str(_DEFAULT_FRONTEND)))

app = FastAPI(title="3D Print Marketplace")

# --- API routers go here (registered before static mount) ---
# app.include_router(jobs.router,     prefix="/api")
# app.include_router(printers.router, prefix="/api")
# app.include_router(search.router,   prefix="/api")

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



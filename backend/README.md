# Marketplace Backend

Python/FastAPI backend for the 3D Print Marketplace.
Serves the frontend SPA at `/` and the admin dashboard at `/admin`.

## Requirements

- Python 3.12+
- [uv](https://docs.astral.sh/uv/getting-started/installation/)

## Start

```bash
uv run serve
```

On first run uv creates `.venv`, installs all dependencies, and starts uvicorn on
`http://0.0.0.0:8000` with `--reload`.

The server expects the `frontend/` directory at `../frontend/` relative to this file.
Override with the `FRONTEND_DIR` environment variable:

```bash
FRONTEND_DIR=/path/to/frontend uv run serve
```

## Tests

```bash
uv run python -m pytest
```

Runs all tests in `tests/`. The static-serving tests are skipped automatically if
`frontend/` is not present.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `FRONTEND_DIR` | `../frontend` | Path to the built frontend directory |
| `X402_SERVICE_URL` | `http://localhost:3402` | URL of the TypeScript x402 payment service |
| `OPENAI_API_KEY` | — | Required for agentic offer selection |

## Project layout

```
src/
  main.py           — FastAPI app, static file mount, entry point
  config.py         — PriceConfig (frozen dataclass, from_env())
  exchange.py       — EUR/USD rate fetcher (open.er-api.com, 5-min cache)
  pricing.py        — compute_quote(): grams + minutes → PriceQuote
  jobs.py           — Job state machine and JobStore
  payment_gateway.py— HTTP client to the x402 TypeScript service
tests/
  test_static.py    — / and /admin serve correct HTML
  test_pricing.py   — pricing arithmetic
  test_jobs.py      — job state transitions and expiry
  test_payment_gateway.py — payment gateway error handling
```

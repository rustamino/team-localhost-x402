# hackathon_x402 — Architecture

## System Overview

3D-printer kiosk on Raspberry Pi (KlipperScreen) + cloud backend.
User scans QR on printer screen → SPA on phone → selects model → pays USDC on Algorand → print starts.

---

## Components

```
                        INTERNET
    ┌───────────────────────────────────────────────────┐
    │              x402.nb3.me (VPS/Cloud)              │
    │                                                   │
    │  ┌─────────┐   ┌──────────────┐   ┌───────────┐  │
    │  │  nginx  │   │   backend    │   │  x402-srv │  │
    │  │ :443    │──►│  Python      │◄─►│ TypeScript│  │
    │  │         │   │  FastAPI     │   │  :3402    │  │
    │  │ /       │   │  :8000       │   │           │  │
    │  │ /api    │   │              │   │ Algorand  │  │
    │  │ /ws     │   │  SQLite      │   │ watcher   │  │
    │  └─────────┘   │  + files vol │   └───────────┘  │
    │       │        └──────┬───────┘         │        │
    │       │               │ HTTP            │ webhook │
    │       │        ┌──────▼───────┐         │        │
    │       │        │   slicer     │         │        │
    │       │        │  CuraEngine  │         │        │
    │       │        │  :8001       │         │        │
    │       │        └──────────────┘         │        │
    └───────┼───────────────────────────────  ┼ ───────┘
            │  HTTPS/WSS                      │
            │                        Algorand testnet
     ┌──────┴──────────────────┐              │
     │  Phone browser (SPA)    │     Pera Wallet (phone)
     │                         │──────────────┘
     │  select → estimate      │   pays USDC via QR
     │  → pay → progress       │
     └─────────────────────────┘

     ┌─────────────────────────┐
     │   klipperpi (RPi4)      │
     │                         │
     │  KlipperScreen panel    │◄─── WebSocket (outbound)
     │  ├─ QR / progress       │────►────────────────────► backend
     │  └─ machine_id          │
     │                         │
     │  Moonraker :7125        │◄── backend cmd (через WS)
     │  Klipper                │
     └─────────────────────────┘
```

## Containers (docker-compose)

| Container | Stack | Port | Role |
|---|---|---|---|
| `nginx` | nginx:alpine | 443 | reverse proxy + SPA static |
| `backend` | Python 3.12, FastAPI | 8000 | REST, WebSocket, job/order logic |
| `x402` | Node 22, TypeScript | 3402 | x402 payment orders, Algorand watcher |
| `slicer` | CuraEngine + Python wrapper | 8001 | STL → G-code, grams, minutes |

Volumes: `files/` (STL + G-code), `db/` (SQLite).

---

## Payment Flow

1. Pi connects via WebSocket, sends status every 5s
2. KlipperScreen shows QR: `https://x402.nb3.me/p/{machine_id}`
3. User opens SPA on phone → selects model (benchy / cute_cat / upload STL)
4. `POST /api/jobs` → backend sends STL to slicer → gets `{grams, minutes}`
5. SPA shows estimate: `grams × $0.035 + minutes × $0.005`
6. User clicks "Pay" → `POST /api/jobs/{id}/checkout`
7. backend → x402: `POST /orders {job_id, amount_usdc}`
8. x402 returns `{order_id, arc26_uri, algo_address, amount_microusdc, expires_at}`
9. SPA shows Algorand QR + Pera Wallet deeplink, polls payment status
10. User pays in Pera Wallet (USDC ASA on Algorand testnet)
11. x402 watcher detects tx: `amount ∈ [expected, expected×1.05]`, `note == order_id`
12. x402 → backend webhook: `POST /internal/payment-confirmed {order_id}`
13. backend → Pi via WebSocket: `{type: "print_job", gcode_url, filename}`
14. Pi downloads G-code, uploads to Moonraker, starts print
15. Pi sends progress via WebSocket → SPA shows live progress

Auto-refund: if payment > expected × 1.05, x402 returns the difference automatically.

---

## Pricing

```python
@dataclass(frozen=True)
class PriceConfig:
    price_per_gram:   Decimal = Decimal("0.035")  # USDC
    price_per_minute: Decimal = Decimal("0.005")  # USDC

    @classmethod
    def from_env(cls): ...

def compute_price(grams, minutes, override=None) -> Decimal:
    # override = {"price_per_gram": 0.020}  per-job, set by operator
    raw = Decimal(grams) * cfg.price_per_gram \
        + Decimal(minutes) * cfg.price_per_minute
    return raw.quantize(Decimal("0.01"), ROUND_HALF_UP)
```

Per-job overrides stored in `jobs.price_config` (JSON field).

---

## WebSocket Protocol (Pi ↔ Backend)

**Pi → Backend** (every 5s):
```json
{
  "type": "status",
  "machine_id": "klipperpi_a0c6",
  "state": "idle|printing|paused|error",
  "temps": {
    "extruder": {"actual": 215.3, "target": 215.0},
    "bed":      {"actual": 60.1,  "target": 60.0}
  },
  "print": {
    "filename": "benchy.gcode",
    "progress": 0.47,
    "filament_used_mm": 1823,
    "eta_seconds": 1420
  }
}
```

**Backend → Pi**:
```json
{"type": "print_job",   "job_id": "j_abc", "gcode_url": "/files/j_abc.gcode", "filename": "benchy.gcode"}
{"type": "print_cancel"}
{"type": "ping"}
```

---

## API Endpoints

### Backend (Python/FastAPI)

| Method | Path | Description |
|---|---|---|
| POST | `/api/register` | Pi registers, gets WS token |
| WS | `/ws/machine/{id}` | persistent Pi connection |
| WS | `/ws/client/{id}` | SPA subscribes to printer status |
| GET | `/api/machines/{id}` | printer status for SPA |
| POST | `/api/jobs` | create job, start slicing |
| GET | `/api/jobs/{id}` | job status + cost estimate |
| POST | `/api/jobs/{id}/checkout` | create payment order via x402 |
| GET | `/api/orders/{id}/status` | payment status (polling) |
| POST | `/internal/payment-confirmed` | webhook from x402 server |

### x402 Server (TypeScript)

| Method | Path | Description |
|---|---|---|
| POST | `/orders` | create order, return ARC-26 QR data |
| GET | `/orders/{id}` | status + tx_id |
| POST | `/orders/{id}/refund` | return overpayment difference |

---

## Algorand / USDC

- Testnet USDC ASA: `10458941` (6 decimals)
- Mainnet USDC ASA: `31566704`
- 1 cent = 10 000 micro-USDC
- Payment QR format (ARC-26): `algorand://ADDR?amount=N&asset=10458941&note=order_id`
- Merchant wallet: single Algorand account, opted into USDC
- Facilitator: Algorand native x402 facilitator (goplausible.xyz / Bazaar)
- Transaction finality: ~3.3s (1 round)

---

## SPA Screens

```
[/p/{machine_id}]

Screen 1 — idle:         Screen 2 — estimate:      Screen 3 — payment:
  🖨 klipperpi СВОБОДЕН    benchy.stl                [QR — ARC-26 deeplink]
  Hotend: 25° Bed: 24°    12.4 г · 47 мин           0.670000 USDC
                           Стоимость: 0.67 USDC      Действует 15 мин
  [Benchy] [Cute cat]      (~€0.67)                  [Открыть Pera Wallet]
  [↑ Загрузить STL]        [Оплатить]                ○○○ ожидание...

Screen 4 — printing:
  🖨 Печатает benchy
  ████████░░░░ 47%
  Осталось ~25 мин
  Hotend: 215° Bed: 60°
```

KlipperScreen on Pi mirrors Screen 1 (QR) while idle, Screen 4 (progress) while printing.

---

## Implementation Notes

- x402 `PAYMENT-SIGNATURE` header: `base64(JSON.stringify({ x402Version, payload: { paymentGroup, paymentIndex }, ... }))` — `paymentGroup`/`paymentIndex` are nested under `payload`, not at the top level
- `@x402/hono` `compiledRoutes` is a snapshot created at startup; dynamic route registration requires direct push/splice into `httpServer.compiledRoutes` (see `reports/library_suggestions.md` for a proposed PR)
- Frontend uses `QRCode.toCanvas` (not `toDataURL`) — the Node.js PNG encoder doesn't work in a browser bundle; qrcode is bundled locally via esbuild
- `klipperscreen/panels/x402_order.py` was removed; the action bar in `base_panel.py` (~line 74) opens `x402_queue` instead

## Implementation Order

1. `machine_id.py` + `POST /api/register` — already have script, need backend endpoint
2. WebSocket bridge — Pi ↔ backend, forwards Moonraker status
3. Backend skeleton — FastAPI, SQLite, jobs/orders models
4. Slicer container — CuraEngine + HTTP wrapper
5. x402 TypeScript server — Algorand watcher, order lifecycle, auto-refund
6. SPA — three screens, WS client
7. KlipperScreen panel — QR vs progress, polling backend
8. docker-compose — nginx, volumes, wiring

---

## Key Files (Pi side)

| File | Description |
|---|---|
| `KlipperScreen/scripts/machine_id.py` | generate/cache machine_id, POST /api/register |
| `KlipperScreen/scripts/ws_bridge.py` | WebSocket client, status sender, job receiver |
| `KlipperScreen/panels/x402_order.py` | QR panel (extend to show estimate + progress) |
| `KlipperScreen/scripts/launch_KlipperScreen.sh` | startup, backend=vnc|xsdl |
| `/etc/systemd/system/adb-touch-bridge.service` | XSDL touch input (enabled) |
| `~/.config/ks_display_backend` | `xsdl` or `vnc` |
| `~/printer_data/machine_id` | cached machine_id |
| `~/printer_data/moonraker.asvc` | allowed services incl. adb-touch-bridge |

# x402 3D-Print Marketplace — Hackathon Report

## What We Built

A fully functional pay-per-print marketplace where a user scans a QR code on a physical 3D printer's touchscreen, selects a model on their phone, pays in USDC on Algorand, and the printer starts automatically — without any manual intervention from the operator.

The system demonstrates the x402 protocol applied to a physical-world IoT use case: micropayments that gate real hardware actions.

---

## Architecture

```
User's phone
  └── SPA (x402.nb3.me)
        ├── selects model, sees price estimate
        ├── pays via Pera Wallet QR or autonomous agent wallet
        └── POST /api/pay → backend drives x402 handshake

Cloud backend  (Python / FastAPI, x402.nb3.me:8000)
  ├── WebSocket printer registry   — printers connect outbound, backend tunnels HTTP
  ├── Offer aggregator             — fans out /info + /quote to all live printers
  ├── AI offer selection           — OpenAI picks the "Agent's Pick"
  ├── x402 payment proxy           — relays X-PAYMENT header to printer over WS
  └── x402-payer (TypeScript)      — signs Algorand USDC tx with agent mnemonic

Printer server  (TypeScript / Hono, per printer, port 5555)
  ├── /quote                       — returns price + payment_url
  ├── /pay/:job_id                 — x402-protected; confirms payment on-chain
  ├── /status                      — queue for KlipperScreen panel
  ├── Moonraker client             — download gcode → upload → start print
  └── Marketplace WS client        — outbound registration, request relay

KlipperScreen panel  (Python / GTK3, on Raspberry Pi)
  ├── QR code linking to marketplace
  ├── Last 2 jobs with payer address suffix and ETA
  └── Accessible via cloud icon in sidebar and x402 Queue menu item

Algorand TestNet
  └── USDC ASA 10458941  (6 decimals)
```

---

## End-to-End Flow

1. Printer boots → `x402-printer` service starts → registers with marketplace over WebSocket
2. KlipperScreen shows x402 panel with QR code: `https://x402.nb3.me`
3. User opens SPA on phone, selects model (Benchy / Mini Benchy)
4. SPA calls `POST /api/offers` → backend fans out `/quote` to all connected printers → AI ranks them
5. User sees offers, clicks **Pay now** → `POST /api/pay`
6. Backend shells out to `x402-payer` TypeScript subprocess, which:
   - GETs `payment_url` → receives `402 Payment Required` with payment requirements
   - Signs a USDC asset-transfer on Algorand TestNet using the agent mnemonic
   - Retries with `PAYMENT-SIGNATURE` header containing base64-encoded `PaymentPayload`
7. Backend's WebSocket proxy forwards the header to the printer server
8. Printer server's x402 middleware calls the Algorand facilitator (`goplausible.xyz`) to verify on-chain
9. Printer server extracts payer address from signed transaction, marks job `paid`, returns `200`
10. Printer server downloads gcode from marketplace, uploads to Moonraker, starts print
11. KlipperScreen panel shows the job: `▶ GE6UCU — done 00:21`

**Confirmed working in production:** full cycle completed with real USDC payment on Algorand TestNet.

---

## Components Implemented

### Backend (`backend/`)

| Module | Description |
|---|---|
| `main.py` | FastAPI app: WebSocket printer registry, `/api/offers`, `/api/pay`, `/printer/:id/pay/:job` proxy |
| `printer_registry.py` | In-memory registry of connected printers; per-request WS relay with timeout |
| `printers.py` | Concurrent offer collection: `/info` + `/quote` fan-out |
| `selection.py` | OpenAI-based offer ranking; graceful fallback if unavailable |
| `payer.py` | Subprocess bridge to `x402-payer/pay.ts` |
| `exchange.py` | USD/USDC rate cache (TTL-based) |
| `x402-payer/pay.ts` | TypeScript: Algorand mnemonic → `ExactAvmScheme` → `wrapFetchWithPayment` |

### Printer Server (`klipperscreen/print_server/`)

| File | Description |
|---|---|
| `app.ts` | Hono routes: `/info`, `/quote`, `/pay/:job_id`, `/status`; job lifecycle |
| `moonrakerClient.ts` | Download gcode → upload to Moonraker → start print → poll progress |
| `marketplaceClient.ts` | WebSocket client: register, relay requests, reconnect with backoff |
| `server.ts` | Entry point with `@hono/node-server` |

### Printer Dummy (`klipperscreen/printer_dummy/`)

Identical structure to the print server but issues an Algorand USDC refund after payment instead of printing. Prices are 3× higher to demonstrate market competition. Useful for demos without a physical printer.

### Frontend (`frontend/`)

Single-page app: model selection, offer grid with AI pick highlighted, payment screen (ARC-26 QR + Pera Wallet deeplink + autonomous pay button), transaction confirmation.

Notable: `qrcode` library bundled locally with esbuild (CDN was unreliable); `QRCode.toCanvas` used instead of `toDataURL` since Node.js PNG encoder fails silently in browser context.

### KlipperScreen Panel (`klipperscreen/klipperscreen_patches/panels/x402_queue.py`)

GTK3 panel inheriting from `ScreenPanel`. Single-screen layout: QR code (top ~60%) + URL label + last 2 jobs at the bottom. Polls `localhost:5555/status` every 5 s in a background thread; updates UI on main thread via `GLib.idle_add`. Accessible from both the sidebar cloud button and the main menu.

---

## Technical Challenges Solved

### Dynamic x402 Route Registration

`@x402/hono`'s `paymentMiddleware` builds `compiledRoutes` once from the routes object at construction time; later mutations are ignored. Since each job gets its own `GET /pay/:job_id` URL (unknown at startup), we needed per-job registration.

**Workaround:** call `paymentMiddlewareFromHTTPServer(httpServer)` directly and push/splice entries into `httpServer.compiledRoutes` at runtime. Fields are public (not marked `private` in TypeScript), so this works without monkey-patching — though it depends on an undocumented internal.

*A `registerRoute()` / `unregisterRoute()` API on `x402HTTPResourceServer` would be the proper fix; details in `reports/library_suggestions.md`.*

### WebSocket Tunnel for NAT Traversal

Printers sit behind home routers with no inbound access. The marketplace backend exposes a single WebSocket endpoint (`/ws/printer`); each printer connects outbound and stays connected. When a payment arrives at `/printer/:id/pay/:job_id`, the backend relays the HTTP request over the tunnel, awaits the response, and returns it. This makes the printer's x402 endpoint publicly reachable without any port forwarding.

### Node.js 22 WebSocket `onclose` Bug

On Node.js 22 with the native `WebSocket` global, `onclose` does not fire when a connection fails during the TLS/HTTP upgrade handshake. Without a fallback, `onerror` alone was not scheduling a reconnect, leaving the printer permanently disconnected. Fixed by calling `scheduleReconnect()` from both `onclose` and `onerror` with a `reconnectPending` dedup flag.

### PaymentPayload Nesting

The payer address is embedded in the signed Algorand transaction inside the `PAYMENT-SIGNATURE` header. The actual structure is `{ x402Version, payload: { paymentGroup: string[], paymentIndex: number } }` (base64-encoded JSON), not a flat object. Extracting the sender required decoding the correct level of nesting before calling `algosdk.decodeSignedTransaction`.

### KlipperScreen Process Accumulation

The KlipperScreen launch script runs the Python process in the background (`&` + `wait`), so the Python child ends up in a separate PAM session scope rather than the systemd service's cgroup. `KillMode=control-group` therefore did not kill it on restart, leading to 3+ concurrent instances at 127% CPU each. Fixed by adding `pkill -f screen.py` at the start of the launch script and a `trap cleanup EXIT TERM INT` that kills `$KS_PID` when the bash wrapper is terminated.

### GLib.idle_add Tight Loop

`GLib.idle_add(callback)` keeps calling the callback as long as it returns `True`. The panel's `_poll()` returns `True` (to keep the `timeout_add` timer alive), so passing it directly to `idle_add` caused it to be called at idle frequency (~1000×/s), spawning a new HTTP thread each time and causing the panel-switching flap. Fixed by calling `self._poll()` directly for the initial fetch instead of via `idle_add`.

---

## Infrastructure

| Item | Detail |
|---|---|
| Domain | `x402.nb3.me` (Cloudflare-proxied) |
| Backend host | VPS running Python/FastAPI via systemd |
| Printer host | Raspberry Pi 4 (klipperpi), Klipper + Moonraker + KlipperScreen |
| Node.js | v22.22.3 via NVM (no root required on Pi) |
| Printer service | `systemctl --user` (no passwordless sudo on Pi) |
| Algorand | TestNet, USDC ASA `10458941` |
| Facilitator | `https://facilitator.goplausible.xyz` |
| AI selection | OpenAI GPT-4o via Responses API |

---

## Known Limitations

- **Gcode is a placeholder.** The marketplace passes a static `benchy.gcode` (homing + heat-up sequence) instead of slicing the selected model. A CuraEngine slicer container was planned but not connected in time. The payment and Moonraker integration are real; only the file content is a stub.
- **In-memory job store.** The printer server holds jobs in a `Map`; they are lost on restart. A SQLite store would survive restarts and enable history.
- **Single agent wallet.** The backend's `x402-payer` uses one shared mnemonic. In production each user would hold their own session wallet funded from Pera, with the browser signing payments directly.
- **No job cleanup.** Completed jobs stay in the queue indefinitely. A TTL or explicit `done` status from Moonraker is needed.

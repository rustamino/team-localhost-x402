# Printer Registration and Polling

## Problem

The current backend reads printer URLs from the `PRINTERS` env var — a static
comma-separated list set at startup. This means:

- Adding or removing a printer requires restarting the backend.
- The admin dashboard (`/api/printers`) has no data source.
- There is no liveness information (is the printer actually up right now?).

The solution is **printer-initiated registration**: each printer server knows the
marketplace backend URL and periodically announces itself. The backend maintains
an in-memory registry that the rest of the system reads instead of `PRINTERS`.

---

## Registration Flow

```
Printer server starts
  │
  ├─► POST /api/printers/register  (immediately)
  │     body: { printer_id, public_base_url, info: { name, location, capabilities } }
  │     response: 200 OK  { registered: true }
  │
  └─► repeat every HEARTBEAT_INTERVAL seconds (e.g. 30 s)
        same POST — backend updates last_seen timestamp
```

The printer keeps polling regardless of whether the marketplace responded, so
short backend restarts are transparent: the printer re-registers on the next
heartbeat and is back in the pool within `HEARTBEAT_INTERVAL` seconds.

---

## Registration Payload

```json
POST /api/printers/register
{
  "printer_id":    "printer_42",
  "public_base_url": "http://192.168.1.42:5555",
  "info": {
    "name":       "BerlinMaker FDM-1",
    "location":   { "lat": 52.52, "lon": 13.40, "city": "Berlin" },
    "capabilities": { "materials": ["PLA", "PETG"], "max_volume_cm3": 400 }
  }
}
```

`public_base_url` is the URL the marketplace will use to reach this printer
(i.e. what `PUBLIC_BASE_URL` is already set to in the printer's `.env`).
It must be reachable from the backend — not `localhost` unless both run on the
same machine.

Response:

```json
{ "registered": true, "heartbeat_interval": 30 }
```

The backend tells the printer what interval to use so the operator can tune it
centrally without redeploying printers.

---

## Backend Registry

The backend keeps a dict in memory:

```python
@dataclass
class RegisteredPrinter:
    printer_id:    str
    base_url:      str
    info:          dict          # cached /info response
    last_seen_at:  float         # time.monotonic()

registry: dict[str, RegisteredPrinter] = {}
```

**Liveness:** a printer is considered **online** if
`time.monotonic() - last_seen_at < PRINTER_OFFLINE_THRESHOLD`
(suggested default: `3 × heartbeat_interval = 90 s`).

**`collect_offers`** reads `registry` instead of the `PRINTERS` env var:
```python
live_urls = [p.base_url for p in registry.values() if p.is_online()]
result = await collect_offers(live_urls, job, rate)
```

**`GET /api/printers`** (admin dashboard) returns the full registry with status:

```json
[
  {
    "printer_id":      "printer_42",
    "name":            "BerlinMaker FDM-1",
    "status":          "online",
    "location":        { "lat": 52.52, "lon": 13.40, "city": "Berlin" },
    "rate_per_gram_eur":   "0.035",
    "rate_per_minute_eur": "0.005",
    "capabilities":    { "materials": ["PLA", "PETG"], "max_volume_cm3": 400 },
    "last_seen_ago_s": 12
  }
]
```

---

## Printer-side Implementation

Add to `printerServer.ts`:

```typescript
const MARKETPLACE_URL = process.env.MARKETPLACE_URL;  // e.g. http://192.168.1.10:8000
const HEARTBEAT_INTERVAL_MS = 30_000;

async function register(): Promise<void> {
  if (!MARKETPLACE_URL) return;
  try {
    await fetch(`${MARKETPLACE_URL}/api/printers/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        printer_id:      printerInfo.printer_id,
        public_base_url: publicBaseUrl,
        info:            printerInfo,
      }),
    });
    console.log(`[register] announced to ${MARKETPLACE_URL}`);
  } catch (err) {
    // Non-fatal: marketplace may be starting up; next heartbeat will retry.
    console.warn(`[register] could not reach marketplace: ${err}`);
  }
}

// Register immediately on startup, then on a fixed interval.
register();
setInterval(register, HEARTBEAT_INTERVAL_MS);
```

If `MARKETPLACE_URL` is not set, the printer runs as a standalone server
(useful for local testing without a marketplace).

---

## Env vars

### Printer server (`.env`)

| Variable | Example | Description |
|---|---|---|
| `MARKETPLACE_URL` | `http://192.168.1.10:8000` | Marketplace backend to register with |
| `PUBLIC_BASE_URL` | `http://192.168.1.42:5555` | This printer's reachable URL (sent in registration) |

### Marketplace backend (`.env`)

| Variable | Default | Description |
|---|---|---|
| `PRINTER_OFFLINE_THRESHOLD` | `90` | Seconds after last heartbeat before printer is offline |
| `PRINTERS` | — | Legacy static list; ignored once a printer self-registers |

---

## Secret sharing — future work

Currently the connection is anonymous: any server that knows the marketplace URL
can register as a printer. This is acceptable for a local hackathon network but
not for production.

Planned for the next stage (Klipper integration):

- **Printer token**: a shared secret issued by the marketplace operator, stored
  in the printer's `.env` as `MARKETPLACE_TOKEN`. Sent in the `Authorization`
  header on every registration request. Backend validates it against a list of
  known tokens.
- **Payment credentials**: the printer's Algorand address (`AVM_ADDRESS`) is
  already in the registration payload (inside `info`). The backend uses it to
  verify that payment routes point to the right wallet, not an impersonator.
- **Printer-specific settings**: slicer speed multiplier, material list, flat
  fee — currently hardcoded or in env. Will be pushed from the backend in the
  registration response once an admin UI for configuration exists.

---

## Current state vs. plan

| | Now | After this doc is implemented |
|---|---|---|
| Printer discovery | `PRINTERS` env var, static | Self-registration via heartbeat |
| Liveness | Unknown | `last_seen_ago_s` per printer |
| Admin dashboard | 404 on `/api/printers` | Live printer grid |
| Auth | None | Token in `Authorization` header (next stage) |
| G-Code delivery | URL logged, not downloaded | Fetched and cached at quote time (Klipper stage) |

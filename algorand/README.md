# x402 Payment Server — Algorand USDC

HTTP server that accepts USDC payments on Algorand and confirms them via on-chain monitoring.
Designed as the payment backend for the x402 kiosk flow.

## Setup

```bash
cp .env.example .env
# edit .env — set SERVER_MNEMONIC to the merchant wallet's 25-word mnemonic
npm install
```

## Running

```bash
# Development (tsx watch — restarts on file change)
npm run dev

# Production
npm run build
npm start
```

Server starts on port `3402` by default (set `PORT` in `.env` to override).

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `SERVER_MNEMONIC` | **required** | 25-word mnemonic of the merchant wallet |
| `ALGO_NETWORK` | `testnet` | `testnet` or `mainnet` |
| `PORT` | `3402` | HTTP listen port |
| `ORDER_TTL_SECONDS` | `900` | How long a pending order stays valid (15 min) |
| `OVERPAYMENT_TOLERANCE` | `0.05` | Accept up to +5% over expected amount silently; above that → auto-refund the excess |

USDC asset ID is selected automatically: testnet → `10458941`, mainnet → `31566704`.

## API

Base URL: `http://localhost:3402`

---

### `POST /orders` — Create payment order

Request body:
```json
{
  "job_id": "print_benchy_001",
  "amount_usdc": 2.13
}
```

| Field | Type | Description |
|---|---|---|
| `job_id` | string | Identifier from the calling system (print job, etc.) |
| `amount_usdc` | number | Amount to charge, max 2 decimal places, must be > 0 |

Response `201 Created`:
```json
{
  "order_id":        "order_3cd003c76c22",
  "job_id":          "print_benchy_001",
  "status":          "pending",
  "amount_usdc":     "2.130000",
  "expires_at":      "2026-06-06T10:08:28.727Z",
  "tx_id":           null,
  "refund_tx_id":    null,
  "paid_usdc":       null,
  "merchant_address": "PDG2DLDS...UCU",
  "asset_id":        10458941,
  "amount_microusdc": 2130000,
  "arc26_uri":       "algorand://PDG2DLDS...?amount=2130000&asset=10458941&note=order_3cd003c76c22",
  "network":         "testnet"
}
```

The `arc26_uri` encodes the complete payment instruction. Use it to generate a QR code.
When scanned by **Pera Wallet** (in TestNet Developer Mode), it pre-fills address, amount, token, and note — user just confirms.

---

### `GET /orders/:id` — Get order status

Response `200 OK`:
```json
{
  "order_id":     "order_3cd003c76c22",
  "job_id":       "print_benchy_001",
  "status":       "paid",
  "amount_usdc":  "2.130000",
  "expires_at":   "2026-06-06T10:08:28.727Z",
  "tx_id":        "ABCDEF...TXN",
  "refund_tx_id": null,
  "paid_usdc":    "2.130000"
}
```

**Status values:**

| Status | Description |
|---|---|
| `pending` | Waiting for payment |
| `paid` | Exact payment received (within tolerance) |
| `overpaid` | Payment received; excess auto-refunded |
| `expired` | TTL elapsed before payment arrived |
| `cancelled` | Cancelled via DELETE |

Poll this endpoint every 2–3 seconds to detect payment confirmation.

---

### `DELETE /orders/:id` — Cancel pending order

Cancels an order that hasn't been paid yet.

Response `200 OK` — the updated order object.  
Response `409 Conflict` — order is not in `pending` state.

---

### `GET /health` — Health check

```json
{
  "status":           "ok",
  "network":          "testnet",
  "merchant_address": "PDG2DLDS...UCU",
  "usdc_asset_id":    10458941
}
```

---

## On-chain watcher

The server runs an `AlgorandSubscriber` that monitors algod for incoming USDC transfers to the merchant address:

- Starts from the **current block tip** on launch (no historical sync)
- Polling: algod push notification when new block arrives (~3 s on testnet)
- Matches by: `type=axfer`, `asset=USDC`, `receiver=merchant`, `note` starting with `order_`
- **Underpayment**: ignored, order stays `pending`
- **Overpayment ≤ tolerance**: accepted as `paid`
- **Overpayment > tolerance**: accepted as `overpaid`, excess sent back automatically with note `refund_<order_id>`

## Project structure

```
src/
  server.ts   — entry point: Express app + watcher startup + graceful shutdown
  config.ts   — typed config loaded from ENV (frozen, from_env pattern)
  orders.ts   — in-memory order store (replace Map with DB for persistence)
  watcher.ts  — AlgorandSubscriber: detects payments, triggers refunds
  routes.ts   — Express router: POST /orders, GET /orders/:id, DELETE, /health
  01_account.ts  — demo: generate / inspect Algorand accounts
  02_usdc.ts     — demo: opt-in to USDC ASA, send transfer
  03_watcher.ts  — demo: standalone watcher with test transactions
```

## Algorand notes

- **Opt-in required**: the merchant wallet must opt into the USDC ASA before it can receive tokens (costs 0.1 ALGO, one-time). Run `02_usdc.ts` to verify.
- **Transaction fee**: ~0.001 ALGO per transfer (paid by sender). Refunds cost the merchant ~0.001 ALGO.
- **Finality**: ~3.3 s (1 round) on both testnet and mainnet.
- **TestNet USDC faucet**: available inside Pera Wallet (Developer Mode → Dispenser), or via Circle's testnet faucet.

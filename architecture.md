# Printer Marketplace — Architecture

## Overview

Printer Marketplace is a multi-sided platform that connects users with 3D-printer operators.
The user uploads an STL file and provides a natural-language selection instruction.
An agent-client, acting on behalf of the user, automatically selects the best offer from registered printers and pays for the job — non-custodially, directly from the user's wallet.

---

## Components

```
User's phone / browser
  ├── SPA (web UI)              — model upload, instruction, offer display
  └── Agent-client (JS/WASM)    — holds user keys locally, selects offer, signs tx

Marketplace (cloud backend, Python)
  ├── REST + WebSocket API
  ├── Slicer (CuraEngine)       — STL → {grams, minutes}
  ├── Offer Aggregator          — collects printer quotes
  └── x402 Facilitator client   — verifies payment proof

Printer Servers (one per operator, Python)
  ├── Pricing Engine            — computes quote from {grams, minutes}
  ├── x402 Resource Server      — returns 402 Payment Required on /pay/{job_id}
  └── Print Controller          — starts job after payment confirmed

Algorand TestNet
  └── USDC ASA 10458941         — payment token
```

---

## Flow

### 1. Upload and Slicing

The user opens the Marketplace SPA, uploads an STL file, and enters a natural-language instruction
(e.g., "cheapest offer that can start within 2 hours and is in Berlin").

The Marketplace backend runs the STL through CuraEngine and obtains:
- `grams` — estimated filament weight
- `minutes` — estimated print time

Slicing happens exactly once, centrally. Individual printers never receive the raw STL at this stage.

### 2. Collecting Offers

Before sending any job, Marketplace has already fetched static metadata from each registered printer:

```
GET /info
→ 200 OK
{
  "printer_id": "printer_42",
  "name": "BerlinMaker FDM-1",
  "location": {"lat": 52.52, "lon": 13.40, "city": "Berlin"},
  "capabilities": {"materials": ["PLA", "PETG"], "max_volume_cm3": 400}
}
```

For each registered printer Marketplace sends a pricing request:

```json
POST /quote
{
  "job_id": "j_abc123",
  "grams": 12.4,
  "minutes": 47
}
```

The printer computes the price internally and responds with availability and a payment handle:

```json
{
  "can_start_at": "2026-06-06T15:00:00Z",
  "payment_url": "https://printer42.example.com/pay/j_abc123"
}
```

`time_to_print` is already known from `minutes` sent in the request.
`location` is already known from `/info`. Neither is repeated in the response.

No STL file is transmitted at this stage.

### 3. Fetching 402 Metadata (price discovery)

For each `payment_url` the Marketplace makes an unauthenticated GET request.
Each printer responds with `402 Payment Required` and a `X-PAYMENT-REQUIRED` header
containing the exact price and payment details:

```
X-PAYMENT-REQUIRED: {
  "scheme": "algorand",
  "address": "ADDR",
  "amount": 670000,
  "asset": 10458941,
  "nonce": "j_abc123"
}
```

The amount field is the authoritative price for this job (micro-USDC, 6 decimals).
This step extracts machine-readable payment requirements without initiating any payment.
The Marketplace merges `/info` metadata, `/quote` availability, and 402 price into one record per printer.

### 4. Agentic Offer Selection

Marketplace calls the OpenAI API (or any LLM) with:
- The user's natural-language instruction
- The full list of quotes annotated with 402 payment metadata

The LLM evaluates whether it can make a confident selection given the instruction and the offers.
If confident, it returns the index of the winning offer. Otherwise it returns `null` with a reason,
and the SPA prompts the user to refine the instruction.

### 5. Payment via Pera Wallet (non-custodial)

The agent-client runs in the user's browser. The Marketplace never holds or sees the user's keys.

After the LLM selects offer `i`:

1. Marketplace returns the winning offer to the SPA, including the ARC-26 payment URI:
   `algorand://ADDR?amount=670000&asset=10458941&note=j_abc123`

2. SPA displays the QR code and a "Open Pera Wallet" deeplink button.

3. The user opens Pera Wallet on their phone, scans the QR or taps the deeplink.
   Pera Wallet shows: recipient address, amount (0.670000 USDC), note (job_id).

4. User confirms. Pera Wallet signs and submits the transaction to Algorand TestNet.

5. The winning printer's x402 server watches for incoming USDC transfers.
   When the transaction is confirmed (~3.3 s), it extracts the job_id from the note field,
   marks the order as paid, and responds with `200 OK` to subsequent requests on `/pay/{job_id}`.

6. The Marketplace polls `/pay/{job_id}` on the winning printer. Once the 402 is resolved,
   it sends the STL file to that printer and commands it to start the job.

7. The printer downloads the G-code (Marketplace sliced it), loads it into Moonraker,
   and starts printing. Progress is streamed back to the SPA via WebSocket.

This flow is non-custodial: the private key never leaves the user's device.
The Marketplace acts only as an aggregator and orchestrator, not as a payment proxy.

---

## Printer x402 Resource Server

Each printer exposes three endpoints:

```
GET /info
  → 200 OK
     {"printer_id": "printer_42", "name": "...", "location": {...}, "capabilities": {...}}

POST /quote
  Body: {"job_id": "j_abc123", "grams": 12.4, "minutes": 47}
  → 200 OK
     {"can_start_at": "2026-06-06T15:00:00Z", "payment_url": "https://.../pay/j_abc123"}

GET /pay/{job_id}
  → 402 Payment Required
     X-PAYMENT-REQUIRED: {"scheme":"algorand","address":"ADDR","amount":670000,"asset":10458941,"nonce":"j_abc123"}

GET /pay/{job_id}   (after on-chain payment detected)
  → 200 OK
     {"status": "paid", "tx_id": "..."}
```

The printer's watcher (AlgorandSubscriber) monitors incoming USDC transfers to its address.
On match (correct amount ± 5% tolerance, note == job_id), it marks the order paid.

---

## Algorand / USDC Details

- Network: TestNet
- USDC ASA ID: `10458941` (6 decimals; 1 USDC = 1 000 000 micro-USDC)
- Payment verification: note field == job_id, amount in [expected, expected × 1.05]
- Overpayment: auto-refunded by the printer's x402 server (separate USDC tx, note `refund_{job_id}`)
- Finality: ~3.3 s (one Algorand round)
- ARC-26 URI: `algorand://ADDR?amount=N&asset=10458941&note=job_id`

---

## Pricing

The Marketplace computes a reference price from the slicer output.
Each printer may apply its own multiplier or flat rate:

```
price_usdc = (grams × price_per_gram + minutes × price_per_minute) / eur_per_usd
```

EUR/USD rate is fetched from open.er-api.com (cached 5 min, falls back to last known).
Prices are displayed in EUR for readability; payment is in USDC.

---

## Data Flow Summary

```
User
 │  upload STL + instruction
 ▼
Marketplace
 │  slice STL → {grams, minutes}
 │  broadcast /quote to all printers
 │  collect quotes + fetch 402 metadata
 │  LLM(instruction, quotes) → winning_index
 │  return winning quote + ARC-26 URI to SPA
 ▼
SPA / Pera Wallet (on user's phone)
 │  user confirms payment in Pera Wallet
 │  Algorand tx submitted
 ▼
Winning Printer x402 watcher
 │  detects tx, marks order paid
 ▼
Marketplace
 │  polls /pay/{job_id} until 200
 │  sends STL to winning printer
 │  sends start command
 ▼
Printer
 │  runs G-code via Klipper/Moonraker
 │  streams progress
 ▼
SPA (live progress bar)
```

---

## Hackathon Scope Limitations

- The agent-client runs in the browser as a thin JS layer; full autonomous key-management is future work.
- The Marketplace polls printers sequentially (no async fan-out) for simplicity.
- A single Marketplace instance; no auth between Marketplace and printers (token-based auth is future work).
- Pera Wallet is used as the x402 client; the "agent pays automatically" mode requires a WASM signer
  or mobile SDK integration that is out of scope for this demo.

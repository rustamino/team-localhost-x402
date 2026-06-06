# Frontend Requirements

## Overview

Single-page application served at `x402.nb3.me`. Mobile-first (primary user journey involves
Pera Wallet on the same phone). No user accounts — session state lives in `sessionStorage`.

---

## Screens

### Screen 1 — Input

Two parallel, equal-weight input paths:

- **Text search**: freeform text describing the desired model; triggers agent search on
  Printables and Cults3D (separate backend module)
- **File upload**: `.stl` file drag-drop or file picker

Both paths also capture:
- **Selection instruction**: natural-language criteria for choosing a printer
  (e.g. "cheapest offer starting today, preferably in Berlin")
  — required field with a sensible placeholder

If both text search and file upload are provided simultaneously, the file upload takes precedence
and the text field is cleared.

**Primary action**: "Find printers" button, disabled until at least one of (text / file) is filled.

---

### Screen 2 — Model Search Results

Shown only when the user entered a text search (not when a file was uploaded directly).

Displays a scrollable list of models returned by the search agent.
Each card shows:
- Thumbnail image (from source site)
- Model name
- Source (printables.com / cults3d.com) with icon
- Star rating
- File type tag (FDM / Resin) and approximate file size
- "Select" button

Selecting a model transitions to Screen 3.

---

### Screen 3 — Processing

Two sequential phases shown as a two-step progress indicator:

**Phase 1 — Slicing** (backend: STL → CuraEngine)
- Label: "Analyzing model…"
- Animated progress bar
- Filename and file size shown

**Phase 2 — Collecting offers** (backend: broadcasting `/quote` to all printers)
- Label: "Requesting printer quotes (N/M)…"
- Counter updates in real time as responses arrive
- Phase 1 line transitions to ✓ checkmark once complete

No user action required. Transitions automatically to Screen 4.

---

### Screen 4 — Offers

Header: filename · grams · reference minutes

Offer cards in order returned, with the agent's selection highlighted at the top.
Each card shows:
- Printer name
- City / location
- Estimated start time (human-readable: "starts in 1h 45m", "tomorrow 09:00", "Friday")
- Price in EUR (primary) and USDC (secondary, 6 dp)

Agent reasoning: a one-sentence LLM explanation displayed below the card list.

**Primary action**: "Pay [printer name]" button.

**Fallback — agent cannot decide** (LLM returned null):
- Warning banner with the LLM's reason
- Two secondary actions: "Clarify instruction" (returns to Screen 1 with fields pre-filled)
  and "Choose manually" (cards become selectable, button label becomes "Pay selected")

---

### Screen 5 — Budget Authorization

Shown after the user confirms the offer selection.

Displays:
- Selected printer name and confirmed price (EUR + USDC)
- One-line explanation: "Fund the agent's session wallet. It will pay the printer and
  return any remainder to your address."
- Input field: user's main Algorand address (for refund routing)
- QR code for the ARC-26 URI: `algorand://SESSION_ADDR?amount=N&asset=10458941`
- Session wallet address with a copy button
- Amount in USDC
- "Open Pera Wallet" deeplink button
- Countdown timer (15-minute TTL on the x402 order)
- Status line: "Waiting for deposit…" — polls the backend or listens on WebSocket

On deposit detected: animates to Screen 6 automatically.

On TTL expiry: shows an error with a "Try again" action that re-creates the order.

---

### Screen 6 — Autonomous Payment

No user action on this screen. Shows the x402 client flow unfolding in real time:

1. ✓ Budget received
2. ⟳ Submitting USDC transfer… → tx_id appears (with AlgoExplorer link)
3. ⟳ Waiting for block confirmation (~3 s)… → block confirmed
4. ⟳ Verifying with Algorand facilitator…
5. ✓ Payment accepted

Each step transitions automatically. Total elapsed time ~5–8 seconds.

On success: transitions to Screen 7.

On failure at any step (facilitator rejection, timeout): shows error with details and
a "Retry payment" action (re-submits from session wallet if funds remain).

---

### Screen 7 — Print Progress

Header: ✓ Paid · Printing

Displays:
- Printer name
- Filename
- Progress bar (0–100%), updated via WebSocket
- Estimated time remaining
- Hotend temperature: actual / target, with ✓ when at setpoint
- Bed temperature: actual / target, with ✓ when at setpoint
- Pick-up location: city + street (from printer `/info`), lat/lon, "Open in Maps" link
- Transaction ID with AlgoExplorer link

On completion (status = `done`):
- Replaces progress bar with "Ready for pick-up 🎉"
- Shows pick-up address prominently

On failure (status = `failed`):
- Shows error from printer
- Note that a refund may be initiated by the printer

---

## State Machine (simplified)

```
idle
  → [text submitted]       searching
  → [file uploaded]        processing

searching
  → [model selected]       processing

processing
  → [slicing done + offers received]   offers

offers
  → [offer confirmed]      authorizing
  → [LLM null]             offers (clarify mode)

authorizing
  → [deposit detected]     paying

paying
  → [facilitator OK]       tracking
  → [failure]              error

tracking
  → [status=done]          done
  → [status=failed]        error
```

---

## API Interactions

| Screen | Call | Notes |
|---|---|---|
| 1 | `POST /api/search` | text → model list |
| 1 | `POST /api/jobs` | file upload, starts slicing |
| 3 | `GET /api/jobs/{id}` (poll / WS) | status: slicing → quoted |
| 4 | — | offers in job response |
| 5 | `POST /api/jobs/{id}/checkout` | creates x402 order, returns session wallet address + amount |
| 5 | `GET /api/jobs/{id}` (poll / WS) | status: checkout → paid (deposit detected) |
| 6 | client-side | x402 SDK: sign tx, submit, retry with X-PAYMENT |
| 7 | `WS /ws/client/{job_id}` | progress, temps |

---

## Session Storage Keys

| Key | Value |
|---|---|
| `session_wallet_sk` | base64-encoded secret key of ephemeral keypair |
| `session_wallet_address` | Algorand address |
| `refund_address` | user's main Algorand address (entered on Screen 5) |
| `job_id` | current job |

Keys are cleared on session cleanup (job done or user navigates away after completion).

---

## Non-Functional Requirements

- Mobile-first responsive layout (375 px minimum width)
- All monetary amounts: EUR with 2 dp, USDC with 6 dp
- AlgoExplorer links open in new tab
- QR codes generated client-side (no third-party service)
- No authentication, no persistent backend sessions
- Works without HTTPS on localhost for development; requires HTTPS in production (Pera Wallet deeplinks)

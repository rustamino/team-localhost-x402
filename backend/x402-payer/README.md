# x402-payer

A one-shot payer the Python backend shells out to in order to pay a printer
offer over the x402 protocol on **Algorand testnet** — no Pera Wallet, no QR.

It is the server-side equivalent of `x402_transactions/x402-demo-client`: it
holds an Algorand mnemonic, registers the Algorand testnet `exact` scheme, and
lets `wrapFetchWithPayment` sign + retry automatically when the printer route
answers `402 Payment Required`.

## Setup

```bash
cd backend/x402-payer
npm install
cp .env.example .env      # set AVM_MNEMONIC to a funded testnet wallet
```

The wallet must hold testnet USDC (ASA `10458941`) + some ALGO for fees and be
opted into the USDC ASA (see `x402_transactions/utilities/opt_in_account.js`).

## Run manually

```bash
npm run pay -- http://localhost:5555/pay/j_abc123
# or
node --import tsx pay.ts http://localhost:5555/pay/j_abc123
```

On success a single JSON object is printed to **stdout** (logs go to stderr):

```json
{ "ok": true, "payer": "PDG2…UCU", "settle": { "...": "..." }, "resource": { "status": "paid", "...": "..." } }
```

On failure: `{ "ok": false, "error": "..." }` and a non-zero exit code.

## How the backend calls it

`backend/src/payer.py` runs `node --import tsx pay.ts <payment_url>` in this
directory and parses the JSON result. Override the launch command with
`X402_PAYER_CMD` and the working dir with `X402_PAYER_DIR` if needed.

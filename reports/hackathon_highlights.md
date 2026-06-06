# x402 Hackathon — Highlights

## What was built

A **distributed pay-per-print marketplace** on the x402 protocol: a user pays once in USDC on Algorand, and an independent 3D printer — potentially owned by a stranger — starts the job automatically. No accounts, no invoices, no trust required between parties.

**Key idea:** x402 turns HTTP endpoints into payment gates. Each printer exposes `GET /pay/:job_id`; the marketplace aggregates offers, the user picks one, the agent wallet signs and submits an Algorand transaction, and the printer only starts after the on-chain proof is verified by a third-party facilitator. The platform never holds funds — money flows directly from user to printer operator.

## Highlights

- **Decentralised supply side.** Any operator plugs in a Raspberry Pi with Klipper and a token, registers over WebSocket, and starts receiving orders. The marketplace sees it as just another offer source.
- **AI offer selection.** The backend fans out quotes to all live printers and asks an LLM to rank them against the user's natural-language instruction ("cheapest in Berlin that can start within 2 hours").
- **Full cycle confirmed live.** Real USDC payment on Algorand TestNet → gcode downloaded → Moonraker started the print → KlipperScreen showed the job with the payer's address suffix.
- **NAT traversal via WebSocket tunnel.** Printers behind home routers connect outbound; the marketplace proxies payment headers to them over the persistent connection. No port forwarding needed.
- **KlipperScreen integration.** Custom GTK3 panel on the printer's touchscreen shows a marketplace QR code when idle and the live job queue (payer, ETA) when printing.

## Library finding

`@x402/hono` does not support runtime route registration — the compiled route list is a snapshot taken at middleware construction, making it impossible to protect dynamically created endpoints (e.g. `GET /pay/:job_id` born after `POST /quote`). A `registerRoute()` / `unregisterRoute()` API on `x402HTTPResourceServer` would close this gap with full backward compatibility; detailed proposal in `reports/library_suggestions.md`.

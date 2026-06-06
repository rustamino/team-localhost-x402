Setup (one-time):
  pnpm install        # Windows / dev machine with pnpm
  npm install         # Linux / CI / any machine with Node.js

Run (Linux / Node.js):
  npm start                              # loads .env by default
  ENV_FILE=.env.printer1 npm start       # custom env file

Run (Windows / pnpm):
  pnpm exec dotenv -e .env.printer1 -- pnpm exec tsx ./printerServer.ts

Required .env variables:
  AVM_ADDRESS=<Algorand address receiving USDC>
  FACILITATOR_URL=<x402 facilitator URL>
  PORT=5555                              # optional, default 5555
  PUBLIC_BASE_URL=http://192.168.x.x:5555  # URL reachable from marketplace
  PRINTER_ID=printer_42                  # optional, for multi-printer setups

Optional .env variables:
  PRINTER_NAME, PRINTER_LAT, PRINTER_LON, PRINTER_CITY
  PRINTER_TIME_MULTIPLIER=1.15          # speed relative to slicer estimate
  PRICE_PER_GRAM_USDC=0.03
  PRICE_PER_MINUTE_USDC=0.005
  FLAT_FEE_USDC=0.10
  CAN_START_DELAY_MINUTES=20

Tests:
  npm test            # or: pnpm test

Try to fetch info from the server (CMD):
  curl http://localhost:5555/info

Try to ask for a quote (CMD):
  curl -X POST http://localhost:5555/quote ^
    -H "Content-Type: application/json" ^
    -d "{\"job_id\":\"j_abc123\",\"grams\":12.4,\"minutes\":47,\"gcode_url\":\"https://marketplace.example.com/files/j_abc123.gcode\"}"

Try to ask for a quote (PowerShell):
  curl -Method POST http://localhost:5555/quote `
    -ContentType "application/json" `
    -Body '{"job_id":"j_abc123","grams":12.4,"minutes":47,"gcode_url":"https://marketplace.example.com/files/j_abc123.gcode"}'

Setup:
pnpm init
pnpm add -D typescript @types/node tsx
pnpm add @x402/core @x402/avm @x402/hono hono @hono/node-server dotenv 

Run (Replace printer1 with a proper printer 1-4):
pnpm exec dotenv -e .env.printer1 -- pnpm exec tsx ./printerServer.ts

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
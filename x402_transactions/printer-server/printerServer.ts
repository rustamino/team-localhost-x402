import { config } from "dotenv";
import { serve } from "@hono/node-server";
import { createApp, configFromEnv } from "./app.js";

config({
  path: process.env.ENV_FILE ?? ".env",
});

const avmAddress = process.env.AVM_ADDRESS;
const facilitatorUrl = process.env.FACILITATOR_URL;

if (!avmAddress || !facilitatorUrl) {
  console.error("Missing environment variables: AVM_ADDRESS or FACILITATOR_URL");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 5555);
const cfg = configFromEnv(port);

const { app } = createApp(cfg);

serve(
  {
    fetch: app.fetch,
    port,
    hostname: "0.0.0.0",
  },
  () => {
    console.log(`Printer x402 Resource Server listening at ${cfg.publicBaseUrl}`);
    console.log(`Local URL: http://localhost:${port}`);
    console.log(`Printer ID: ${cfg.printerInfo.printer_id}`);
    console.log(`Receiving USDC to AVM_ADDRESS: ${avmAddress}`);
  },
);

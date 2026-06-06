import { config } from "dotenv";
import { serve } from "@hono/node-server";
import { createApp, configFromEnv } from "./app.js";
import { connectMarketplace } from "./marketplaceClient.js";

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

const marketplaceUrl = process.env.MARKETPLACE_URL;
const marketplaceToken = process.env.MARKETPLACE_TOKEN;

if (marketplaceUrl && marketplaceToken) {
  connectMarketplace(cfg, marketplaceUrl, marketplaceToken, app);
} else {
  console.warn(
    "[marketplace] MARKETPLACE_URL or MARKETPLACE_TOKEN not set — running in standalone mode. " +
    "Set both env vars to register with the marketplace backend.",
  );
}

serve(
  {
    fetch: app.fetch,
    port,
    hostname: "0.0.0.0",
  },
  () => {
    console.log(`Printer x402 Resource Server listening on port ${port}`);
    console.log(`Printer ID: ${cfg.printerInfo.printer_id}`);
    console.log(`Receiving USDC to AVM_ADDRESS: ${avmAddress}`);
  },
);

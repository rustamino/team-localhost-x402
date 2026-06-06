import { serve } from "@hono/node-server";
import { configFromEnv, createApp } from "./app.js";
import { connectMarketplace } from "./marketplaceClient.js";

const PORT = Number(process.env.PORT ?? 5556);
const cfg = configFromEnv(PORT);

const { app } = createApp(cfg);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[printer-dummy] ${cfg.printerInfo.printer_id} listening on :${PORT}`);
  if (!cfg.avmMnemonic) {
    console.warn("[printer-dummy] AVM_MNEMONIC not set — refunds will be simulated only");
  }
});

const marketplaceUrl = process.env.MARKETPLACE_URL;
const marketplaceToken = process.env.MARKETPLACE_TOKEN;

if (marketplaceUrl && marketplaceToken) {
  connectMarketplace(cfg, marketplaceUrl, marketplaceToken, app);
} else {
  console.warn("[printer-dummy] MARKETPLACE_URL/MARKETPLACE_TOKEN not set — running standalone");
}

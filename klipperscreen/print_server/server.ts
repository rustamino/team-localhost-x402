import { serve } from "@hono/node-server";
import { configFromEnv, createApp } from "./app.js";
import { connectMarketplace } from "./marketplaceClient.js";

const PORT = Number(process.env.PORT ?? 5555);
const cfg = configFromEnv(PORT);

const { app } = createApp(cfg);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[printer-server] ${cfg.printerInfo.printer_id} listening on :${PORT}`);
});

const marketplaceUrl = process.env.MARKETPLACE_URL;
const marketplaceToken = process.env.MARKETPLACE_TOKEN;

if (marketplaceUrl && marketplaceToken) {
  connectMarketplace(cfg, marketplaceUrl, marketplaceToken, app);
} else {
  console.warn("[printer-server] MARKETPLACE_URL/MARKETPLACE_TOKEN not set — running standalone");
}

import express from "express";
import { config } from "./config";
import { OrderStore } from "./orders";
import { createWatcher } from "./watcher";
import { createRouter } from "./routes";

const app = express();
app.use(express.json());

const store = new OrderStore(config.orderTtlSeconds);
app.use("/", createRouter(config, store));

const watcher = createWatcher(config, store);

const server = app.listen(config.port, () => {
  const addr = config.serverAccount.addr.toString();
  console.log(`[server] x402 payment server started`);
  console.log(`[server] network:  ${config.network}`);
  console.log(`[server] port:     ${config.port}`);
  console.log(`[server] merchant: ${addr}`);
  console.log(`[server] USDC ASA: ${config.usdcAssetId}`);
  console.log(`[server] order TTL: ${config.orderTtlSeconds}s`);
});

watcher.start();
console.log(`[watcher] started`);

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`\n[server] ${signal} received — shutting down`);
  await watcher.stop(signal);
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

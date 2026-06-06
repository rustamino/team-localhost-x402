import { Router, Request, Response } from "express";
import { Config } from "./config";
import { OrderStore } from "./orders";

const USDC_DECIMALS = 6;

function arc26Uri(address: string, microUsdc: bigint, assetId: bigint, note: string): string {
  return `algorand://${address}?amount=${microUsdc}&asset=${assetId}&note=${encodeURIComponent(note)}`;
}

export function createRouter(config: Config, store: OrderStore): Router {
  const router = Router();
  const merchantAddress = config.serverAccount.addr.toString();

  // POST /orders — create a new payment order
  router.post("/orders", (req: Request, res: Response) => {
    const { job_id, amount_usdc } = req.body as {
      job_id?: unknown;
      amount_usdc?: unknown;
    };

    if (typeof job_id !== "string" || !job_id.trim()) {
      res.status(400).json({ error: "job_id must be a non-empty string" });
      return;
    }
    const amount = Number(amount_usdc);
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: "amount_usdc must be a positive number" });
      return;
    }
    if (Math.round(amount * 100) / 100 !== amount) {
      res.status(400).json({ error: "amount_usdc must have at most 2 decimal places" });
      return;
    }

    const order = store.create(job_id.trim(), amount);

    res.status(201).json({
      ...store.toJSON(order),
      merchant_address: merchantAddress,
      asset_id: Number(config.usdcAssetId),
      amount_microusdc: Number(order.expectedMicroUsdc),
      arc26_uri: arc26Uri(
        merchantAddress,
        order.expectedMicroUsdc,
        config.usdcAssetId,
        order.orderId
      ),
      network: config.network,
    });
  });

  // GET /orders/:id — get order status
  router.get("/orders/:id", (req: Request, res: Response) => {
    const order = store.get(String(req.params.id));
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    res.json(store.toJSON(order));
  });

  // DELETE /orders/:id — cancel a pending order
  router.delete("/orders/:id", (req: Request, res: Response) => {
    const order = store.get(String(req.params.id));
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    if (order.status !== "pending") {
      res.status(409).json({ error: `Cannot cancel order with status: ${order.status}` });
      return;
    }
    order.status = "cancelled";
    res.json(store.toJSON(order));
  });

  // GET /health
  router.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      network: config.network,
      merchant_address: merchantAddress,
      usdc_asset_id: Number(config.usdcAssetId),
    });
  });

  return router;
}

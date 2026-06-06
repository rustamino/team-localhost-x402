/**
 * WebSocket client — identical to print_server/marketplaceClient.ts.
 * Connects this dummy printer server to the marketplace backend.
 */

import type { AppConfig } from "./app.js";
import type { Hono } from "hono";

const MIN_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

function wsUrl(marketplaceUrl: string): string {
  return marketplaceUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws/printer";
}

async function routeThroughApp(
  app: Hono,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  const init: RequestInit = { method, headers: new Headers(headers) };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Headers).set("content-type", "application/json");
  }
  const resp = await app.fetch(new Request(`http://localhost${path}`, init));
  const respHeaders: Record<string, string> = {};
  resp.headers.forEach((v, k) => { respHeaders[k] = v; });
  let respBody: unknown;
  const ct = resp.headers.get("content-type") ?? "";
  try { respBody = ct.includes("json") ? await resp.json() : await resp.text(); } catch { respBody = {}; }
  return { status: resp.status, headers: respHeaders, body: respBody };
}

export function connectMarketplace(cfg: AppConfig, marketplaceUrl: string, token: string, app: Hono): void {
  let delay = MIN_DELAY_MS;

  let reconnectPending = false;
  function scheduleReconnect(): void {
    if (reconnectPending) return;
    reconnectPending = true;
    console.log(`[marketplace] reconnecting in ${delay}ms…`);
    setTimeout(() => {
      delay = Math.min(delay * 2, MAX_DELAY_MS);
      reconnectPending = false;
      connect();
    }, delay);
  }

  function connect(): void {
    const url = wsUrl(marketplaceUrl);
    console.log(`[marketplace] connecting to ${url}`);
    const ws = new WebSocket(url);

    ws.onopen = () => {
      delay = MIN_DELAY_MS;
      ws.send(JSON.stringify({ type: "register", token, info: cfg.printerInfo }));
    };

    ws.onmessage = async (event: MessageEvent) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(event.data as string); } catch { return; }

      if (msg.type === "registered") {
        cfg.publicBaseUrl = msg.proxy_base_url as string;
        console.log(`[marketplace] registered. Payment proxy base: ${cfg.publicBaseUrl}`);
      } else if (msg.type === "error") {
        console.error(`[marketplace] registration rejected: ${msg.message}`);
        ws.close();
      } else if (msg.type === "request") {
        const { request_id, method, path, headers = {}, body } = msg as {
          request_id: string; method: string; path: string;
          headers?: Record<string, string>; body?: unknown;
        };
        try {
          const result = await routeThroughApp(app, method, path, headers, body);
          ws.send(JSON.stringify({ type: "response", request_id, ...result }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "response", request_id, status: 500, headers: {}, body: { error: String(err) } }));
        }
      } else if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    };

    ws.onclose = () => {
      console.log("[marketplace] disconnected.");
      scheduleReconnect();
    };

    ws.onerror = (err: Event) => {
      console.error("[marketplace] WebSocket error:", (err as ErrorEvent).message ?? err);
      scheduleReconnect(); // onclose may not fire after handshake failure in Node.js 22
    };
  }

  connect();
}

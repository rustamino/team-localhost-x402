import { Hono } from "hono";
import algosdk from "algosdk";
import { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer } from "@x402/hono";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { ALGORAND_TESTNET_CAIP2, USDC_TESTNET_ASA_ID } from "@x402/avm";
import { downloadGcode, uploadGcode, startPrint, getPrintProgress } from "./moonrakerClient.js";

export type JobStatus = "quoted" | "paid" | "printing" | "done";

export type PrintJob = {
  job_id: string;
  grams: number;
  marketplace_minutes: number;
  printer_minutes: number;
  gcode_url: string;
  can_start_at: string;
  price_usdc: number;
  payment_url: string;
  status: JobStatus;
  created_at: string;
  payer_address: string | null;
  payer_short: string | null;
  started_at: string | null;
  eta: string | null;
};

export type PrinterInfo = {
  printer_id: string;
  name: string;
  location: { lat: number; lon: number; city: string };
  capabilities: { materials: string[]; max_volume_cm3: number };
};

export type AppConfig = {
  avmAddress: string;
  facilitatorUrl: string;
  publicBaseUrl: string;
  printerInfo: PrinterInfo;
  printerTimeMultiplier: number;
  pricePerGram: number;
  pricePerMinute: number;
  flatFee: number;
  canStartDelayMinutes: number;
};

export function configFromEnv(port: number): AppConfig {
  return {
    avmAddress: process.env.AVM_ADDRESS ?? "",
    facilitatorUrl: process.env.FACILITATOR_URL ?? "",
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
    printerInfo: {
      printer_id: process.env.PRINTER_ID ?? "printer_pi",
      name: process.env.PRINTER_NAME ?? "Pi Printer FDM-1",
      location: {
        lat: Number(process.env.PRINTER_LAT ?? 52.52),
        lon: Number(process.env.PRINTER_LON ?? 13.4),
        city: process.env.PRINTER_CITY ?? "Berlin",
      },
      capabilities: {
        materials: ["PLA", "PETG"],
        max_volume_cm3: 400,
      },
    },
    printerTimeMultiplier: Number(process.env.PRINTER_TIME_MULTIPLIER ?? 1.15),
    pricePerGram: Number(process.env.PRICE_PER_GRAM_USDC ?? 0.03),
    pricePerMinute: Number(process.env.PRICE_PER_MINUTE_USDC ?? 0.005),
    flatFee: Number(process.env.FLAT_FEE_USDC ?? 0.1),
    canStartDelayMinutes: Number(process.env.CAN_START_DELAY_MINUTES ?? 20),
  };
}

export function computePrinterMinutes(marketplaceMinutes: number, multiplier: number): number {
  return Math.ceil(marketplaceMinutes * multiplier);
}

export function computePriceUsdc(
  grams: number,
  printerMinutes: number,
  pricePerGram: number,
  pricePerMinute: number,
  flatFee: number,
): number {
  const price = grams * pricePerGram + printerMinutes * pricePerMinute + flatFee;
  return Math.ceil(price * 1_000_000) / 1_000_000;
}

export function requireNumber(value: unknown, fieldName: string): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) throw new Error(`Invalid numeric field: ${fieldName}`);
  return num;
}

export function validateJobId(jobId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) {
    throw new Error("job_id may contain only letters, numbers, _ and -");
  }
}

/**
 * Extract payer Algorand address from the x402 AVM payment header.
 * Header value is base64-encoded JSON: { paymentGroup: string[], paymentIndex: number }
 * paymentGroup[paymentIndex] is a base64-encoded Algorand SignedTransaction.
 */
function extractPayerAddress(header: string | undefined): string | null {
  if (!header) return null;
  try {
    const outer = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      payload: { paymentGroup: string[]; paymentIndex: number };
    };
    const { paymentGroup, paymentIndex } = outer.payload;
    const txBytes = Buffer.from(paymentGroup[paymentIndex], "base64");
    const { txn } = algosdk.decodeSignedTransaction(new Uint8Array(txBytes));
    return txn.sender.toString();
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget: start the Moonraker print sequence after payment.
 * Errors are logged but not thrown (response was already sent).
 */
async function triggerMoonrakerPrint(job: PrintJob, cfg: AppConfig): Promise<void> {
  const filename = `${job.job_id}.gcode`;
  try {
    console.log(`[moonraker] downloading gcode for job ${job.job_id}`);
    const data = await downloadGcode(job.gcode_url);

    console.log(`[moonraker] uploading ${filename} (${data.length} bytes)`);
    await uploadGcode(filename, data);

    console.log(`[moonraker] starting print: ${filename}`);
    await startPrint(filename);

    job.status = "printing";
    job.started_at = new Date().toISOString();
    job.eta = new Date(Date.now() + job.printer_minutes * 60_000).toISOString();
    console.log(`[moonraker] print started. ETA: ${job.eta}`);
  } catch (err) {
    console.error(`[moonraker] failed to start print for job ${job.job_id}:`, err);
  }
}

export function createApp(cfg: AppConfig, { enableX402 = true }: { enableX402?: boolean } = {}) {
  const jobs = new Map<string, PrintJob>();

  const app = new Hono();

  let httpServer: x402HTTPResourceServer | null = null;
  if (enableX402) {
    const facilitatorClient = new HTTPFacilitatorClient({ url: cfg.facilitatorUrl });
    const x402Server = new x402ResourceServer(facilitatorClient);
    const avmServerScheme = new ExactAvmScheme();
    x402Server.register(ALGORAND_TESTNET_CAIP2, avmServerScheme);
    httpServer = new x402HTTPResourceServer(x402Server, {});
    app.use(paymentMiddlewareFromHTTPServer(httpServer));
  }

  function registerPaymentRequirement(job: PrintJob): void {
    if (!httpServer) return;
    const routeKey = `GET /pay/${job.job_id}`;
    const config = {
      accepts: [{
        scheme: "exact",
        price: `$${job.price_usdc.toFixed(6)}`,
        network: ALGORAND_TESTNET_CAIP2,
        payTo: cfg.avmAddress,
        extra: { asset: Number(USDC_TESTNET_ASA_ID) },
      }],
      description: `3D print job ${job.job_id} on ${cfg.printerInfo.name}`,
    };
    const hs = httpServer as any;
    const parsed = hs.parseRoutePattern(routeKey);
    hs.compiledRoutes.push({ verb: parsed.verb, regex: parsed.regex, config, pattern: parsed.path });
    console.log(`Registered x402 payment route: ${routeKey}`);
  }

  function deregisterPaymentRequirement(jobId: string): void {
    if (!httpServer) return;
    const hs = httpServer as any;
    const idx = hs.compiledRoutes.findIndex((r: any) => r.pattern === `/pay/${jobId}`);
    if (idx !== -1) hs.compiledRoutes.splice(idx, 1);
  }

  app.get("/info", c => c.json(cfg.printerInfo));

  app.get("/status", async c => {
    const queue = Array.from(jobs.values())
      .filter(j => j.status === "paid" || j.status === "printing")
      .sort((a, b) => {
        if (!a.started_at && !b.started_at) return 0;
        if (!a.started_at) return 1;
        if (!b.started_at) return -1;
        return a.started_at.localeCompare(b.started_at);
      })
      .map(j => ({
        job_id: j.job_id,
        payer_short: j.payer_short,
        status: j.status,
        started_at: j.started_at,
        eta: j.eta,
      }));

    // Refresh ETA for the currently printing job from Moonraker
    const printing = queue.find(j => j.status === "printing");
    if (printing) {
      const progress = await getPrintProgress().catch(() => null);
      if (progress?.etaSeconds != null) {
        printing.eta = new Date(Date.now() + progress.etaSeconds * 1_000).toISOString();
        const job = jobs.get(printing.job_id);
        if (job) job.eta = printing.eta;
      }
    }

    return c.json({ printer_id: cfg.printerInfo.printer_id, queue });
  });

  app.post("/quote", async c => {
    try {
      const body = await c.req.json();

      const jobId = String(body.job_id ?? "").trim();
      if (!jobId) return c.json({ error: "Missing job_id" }, 400);
      try { validateJobId(jobId); } catch (e) { return c.json({ error: (e as Error).message }, 400); }

      const grams = requireNumber(body.grams, "grams");
      const marketplaceMinutes = requireNumber(body.minutes, "minutes");
      const gcodeUrl = String(body.gcode_url ?? "").trim();
      if (!gcodeUrl) return c.json({ error: "Missing gcode_url" }, 400);

      const printerMinutes = computePrinterMinutes(marketplaceMinutes, cfg.printerTimeMultiplier);
      const priceUsdc = computePriceUsdc(grams, printerMinutes, cfg.pricePerGram, cfg.pricePerMinute, cfg.flatFee);
      const canStartAt = new Date(Date.now() + cfg.canStartDelayMinutes * 60_000).toISOString();
      const paymentUrl = `${cfg.publicBaseUrl}/pay/${encodeURIComponent(jobId)}`;

      const job: PrintJob = {
        job_id: jobId,
        grams,
        marketplace_minutes: marketplaceMinutes,
        printer_minutes: printerMinutes,
        gcode_url: gcodeUrl,
        can_start_at: canStartAt,
        price_usdc: priceUsdc,
        payment_url: paymentUrl,
        status: "quoted",
        created_at: new Date().toISOString(),
        payer_address: null,
        payer_short: null,
        started_at: null,
        eta: null,
      };

      jobs.set(jobId, job);
      registerPaymentRequirement(job);

      console.log(`Quote for job ${jobId}: ${grams}g, ${marketplaceMinutes}min → $${priceUsdc}`);
      return c.json({ can_start_at: canStartAt, payment_url: paymentUrl });
    } catch (error) {
      console.error("Quote error:", error);
      return c.json({ error: "Failed to create quote", details: String(error) }, 400);
    }
  });

  app.get("/pay/:job_id", async c => {
    const jobId = c.req.param("job_id");
    const job = jobs.get(jobId);
    if (!job) return c.json({ error: "Unknown job_id" }, 404);

    // Extract payer address from the x402 AVM payment header
    const paymentHeader = c.req.header("payment-signature") ?? c.req.header("x-payment");
    const payerAddress = extractPayerAddress(paymentHeader);
    job.payer_address = payerAddress;
    job.payer_short = payerAddress ? payerAddress.slice(-6) : null;

    job.status = "paid";
    jobs.set(jobId, job);
    deregisterPaymentRequirement(jobId);

    console.log(`Payment confirmed for job ${jobId} from ${job.payer_short ?? "unknown"}`);

    // Start Moonraker print asynchronously — don't block the 200 response
    triggerMoonrakerPrint(job, cfg);

    return c.json({
      status: "paid",
      job_id: job.job_id,
      printer_id: cfg.printerInfo.printer_id,
      price_usdc: job.price_usdc,
      message: "Payment confirmed. Print job queued.",
    });
  });

  app.get("/jobs", c => c.json({ jobs: Array.from(jobs.values()) }));

  return { app, jobs };
}

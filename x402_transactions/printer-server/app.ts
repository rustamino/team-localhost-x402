import { Hono } from "hono";

import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { ALGORAND_TESTNET_CAIP2, USDC_TESTNET_ASA_ID } from "@x402/avm";

export type JobStatus = "quoted" | "paid" | "started";

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
  const avmAddress = process.env.AVM_ADDRESS ?? "";
  const facilitatorUrl = process.env.FACILITATOR_URL ?? "";
  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;

  return {
    avmAddress,
    facilitatorUrl,
    publicBaseUrl,
    printerInfo: {
      printer_id: process.env.PRINTER_ID ?? "printer_42",
      name: process.env.PRINTER_NAME ?? "Hackathon Printer FDM-1",
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
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`Invalid numeric field: ${fieldName}`);
  }
  return num;
}

export function createApp(cfg: AppConfig, { enableX402 = true }: { enableX402?: boolean } = {}) {
  const jobs = new Map<string, PrintJob>();
  const paymentRequirements: Record<string, unknown> = {};

  const app = new Hono();

  if (enableX402) {
    const facilitatorClient = new HTTPFacilitatorClient({ url: cfg.facilitatorUrl });
    const x402Server = new x402ResourceServer(facilitatorClient);
    const avmServerScheme = new ExactAvmScheme();
    x402Server.register(ALGORAND_TESTNET_CAIP2, avmServerScheme);
    app.use(paymentMiddleware(paymentRequirements, x402Server));
  }

  function registerPaymentRequirement(job: PrintJob) {
    const routeKey = `GET /pay/${job.job_id}`;
    paymentRequirements[routeKey] = {
      accepts: [
        {
          scheme: "exact",
          price: `$${job.price_usdc.toFixed(6)}`,
          network: ALGORAND_TESTNET_CAIP2,
          payTo: cfg.avmAddress,
          extra: {
            asset: Number(USDC_TESTNET_ASA_ID),
          },
        },
      ],
      description: `3D print job ${job.job_id} on ${cfg.printerInfo.name}`,
    };
    console.log(`Registered x402 payment route: GET /pay/${job.job_id}`);
  }

  app.get("/info", c => c.json(cfg.printerInfo));

  app.post("/quote", async c => {
    try {
      const body = await c.req.json();

      const jobId = String(body.job_id ?? "").trim();
      if (!jobId) return c.json({ error: "Missing job_id" }, 400);

      const grams = requireNumber(body.grams, "grams");
      const marketplaceMinutes = requireNumber(body.minutes, "minutes");

      const gcodeUrl = String(body.gcode_url ?? "").trim();
      if (!gcodeUrl) return c.json({ error: "Missing gcode_url" }, 400);

      console.log(`Quote for job ${jobId}: ${grams}g, ${marketplaceMinutes}min, ${gcodeUrl}`);

      const printerMinutes = computePrinterMinutes(marketplaceMinutes, cfg.printerTimeMultiplier);
      const priceUsdc = computePriceUsdc(
        grams,
        printerMinutes,
        cfg.pricePerGram,
        cfg.pricePerMinute,
        cfg.flatFee,
      );
      const canStartAt = new Date(
        Date.now() + cfg.canStartDelayMinutes * 60_000,
      ).toISOString();
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
      };

      jobs.set(jobId, job);
      registerPaymentRequirement(job);

      return c.json({ can_start_at: canStartAt, payment_url: paymentUrl });
    } catch (error) {
      console.error("Quote error:", error);
      return c.json(
        {
          error: "Failed to create quote",
          details: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
  });

  app.get("/pay/:job_id", c => {
    const jobId = c.req.param("job_id");
    const job = jobs.get(jobId);

    if (!job) return c.json({ error: "Unknown job_id" }, 404);

    job.status = "paid";
    jobs.set(jobId, job);

    const routeKey = `GET /pay/${jobId}`;
    delete paymentRequirements[routeKey];

    console.log(`Payment confirmed for job ${jobId}`);

    return c.json({
      status: "paid",
      job_id: job.job_id,
      printer_id: cfg.printerInfo.printer_id,
      price_usdc: job.price_usdc,
      gcode_url: job.gcode_url,
      message: "Payment confirmed. Print job can be started.",
    });
  });

  app.get("/jobs", c => c.json({ jobs: Array.from(jobs.values()) }));

  return { app, jobs, paymentRequirements };
}

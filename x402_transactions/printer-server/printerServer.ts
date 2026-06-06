import { config } from "dotenv";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { ALGORAND_TESTNET_CAIP2, USDC_TESTNET_ASA_ID } from "@x402/avm";

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

// Важно для marketplace: если сервер доступен с другого устройства,
// PUBLIC_BASE_URL должен быть не localhost, а например:
// http://192.168.43.12:5555
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;

// -----------------------------
// Printer metadata
// -----------------------------

const printerInfo = {
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
};

// -----------------------------
// Simple in-memory job storage
// -----------------------------

type JobStatus = "quoted" | "paid" | "started";

type PrintJob = {
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

const jobs = new Map<string, PrintJob>();

// -----------------------------
// x402 initialization
// -----------------------------

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
const x402Server = new x402ResourceServer(facilitatorClient);

const avmServerScheme = new ExactAvmScheme();
x402Server.register(ALGORAND_TESTNET_CAIP2, avmServerScheme);

const app = new Hono();

/**
 * ВАЖНО:
 *
 * paymentRequirements — общий mutable объект.
 * При POST /quote мы добавляем сюда новый ключ:
 *
 *   "GET /pay/j_abc123"
 *
 * После этого paymentMiddleware начинает защищать этот endpoint.
 *
 * Для хакатона это самый простой способ сделать dynamic /pay/{job_id},
 * не меняя x402 API и не переписывая middleware.
 */
const paymentRequirements: Record<string, any> = {};

app.use(paymentMiddleware(paymentRequirements, x402Server));

// -----------------------------
// Helpers
// -----------------------------

function requireNumber(value: unknown, fieldName: string): number {
  const num = Number(value);

  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`Invalid numeric field: ${fieldName}`);
  }

  return num;
}

function computePrinterMinutes(marketplaceMinutes: number): number {
  // Имитация того, что конкретный принтер печатает иначе,
  // чем generic CuraEngine estimate.
  //
  // Например:
  // 1.15 = этот принтер на 15% медленнее generic estimate.
  const printerSpeedMultiplier = Number(process.env.PRINTER_TIME_MULTIPLIER ?? 1.15);

  return Math.ceil(marketplaceMinutes * printerSpeedMultiplier);
}

function computePriceUsdc(grams: number, printerMinutes: number): number {
  // Очень простая pricing model для демо.
  //
  // Можно вынести в env:
  // PRICE_PER_GRAM_USDC=0.03
  // PRICE_PER_MINUTE_USDC=0.005
  // FLAT_FEE_USDC=0.10

  const pricePerGram = Number(process.env.PRICE_PER_GRAM_USDC ?? 0.03);
  const pricePerMinute = Number(process.env.PRICE_PER_MINUTE_USDC ?? 0.005);
  const flatFee = Number(process.env.FLAT_FEE_USDC ?? 0.1);

  const price = grams * pricePerGram + printerMinutes * pricePerMinute + flatFee;

  // Округлим до 6 знаков, потому что USDC = 6 decimals.
  return Math.ceil(price * 1_000_000) / 1_000_000;
}

function computeCanStartAt(): string {
  // Для демо: принтер может начать через 20 минут.
  const delayMinutes = Number(process.env.CAN_START_DELAY_MINUTES ?? 20);
  return new Date(Date.now() + delayMinutes * 60_000).toISOString();
}

function registerPaymentRequirement(job: PrintJob) {
  const routeKey = `GET /pay/${job.job_id}`;

  paymentRequirements[routeKey] = {
    accepts: [
      {
        scheme: "exact",
        price: `$${job.price_usdc.toFixed(6)}`,
        network: ALGORAND_TESTNET_CAIP2,
        payTo: avmAddress,
        extra: {
          asset: USDC_TESTNET_ASA_ID,
        },
      },
    ],
    description: `3D print job ${job.job_id} on ${printerInfo.name}`,
  };

  console.log("Registered x402 payment route:");
  console.log(routeKey);
  console.log(paymentRequirements[routeKey]);
}

// -----------------------------
// Endpoints
// -----------------------------

app.get("/info", c => {
  return c.json(printerInfo);
});

app.post("/quote", async c => {
  try {
    const body = await c.req.json();

    const jobId = String(body.job_id ?? "").trim();

    if (!jobId) {
      return c.json({ error: "Missing job_id" }, 400);
    }

    const grams = requireNumber(body.grams, "grams");
    const marketplaceMinutes = requireNumber(body.minutes, "minutes");

    const gcodeUrl = String(body.gcode_url ?? "").trim();

    if (!gcodeUrl) {
      return c.json({ error: "Missing gcode_url" }, 400);
    }

    // В реальной версии принтер здесь скачает G-Code:
    // await downloadAndCacheGCode(gcodeUrl, jobId)
    //
    // Для хакатона просто логируем.
    console.log(`Received quote request for job ${jobId}`);
    console.log(`Pretending to download and cache G-Code from: ${gcodeUrl}`);

    const printerMinutes = computePrinterMinutes(marketplaceMinutes);
    const priceUsdc = computePriceUsdc(grams, printerMinutes);
    const canStartAt = computeCanStartAt();

    const paymentUrl = `${publicBaseUrl}/pay/${encodeURIComponent(jobId)}`;

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

    return c.json({
      can_start_at: canStartAt,
      payment_url: paymentUrl,
    });
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

/**
 * Этот endpoint защищён x402 middleware.
 *
 * Первый GET без оплаты:
 *   → 402 Payment Required
 *
 * Повторный GET с payment proof:
 *   → middleware пропускает сюда
 *   → мы считаем job paid
 *   → возвращаем 200 OK
 */
app.get("/pay/:job_id", c => {
  const jobId = c.req.param("job_id");
  const job = jobs.get(jobId);

  if (!job) {
    return c.json({ error: "Unknown job_id" }, 404);
  }

  job.status = "paid";
  jobs.set(jobId, job);

  console.log(`Payment confirmed for job ${jobId}`);
  console.log("Pretending to unlock print job / start print controller...");

  return c.json({
    status: "paid",
    job_id: job.job_id,
    printer_id: printerInfo.printer_id,
    price_usdc: job.price_usdc,
    gcode_url: job.gcode_url,
    message: "Payment confirmed. Print job can be started.",
  });
});

// Debug endpoint для хакатона.
// Можно удалить позже.
app.get("/jobs", c => {
  return c.json({
    jobs: Array.from(jobs.values()),
  });
});

serve(
  {
    fetch: app.fetch,
    port,
    hostname: "0.0.0.0",
  },
  () => {
    console.log(`Printer x402 Resource Server listening at ${publicBaseUrl}`);
    console.log(`Local URL: http://localhost:${port}`);
    console.log(`Printer ID: ${printerInfo.printer_id}`);
    console.log(`Receiving USDC to AVM_ADDRESS: ${avmAddress}`);
  },
);
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  computePrinterMinutes,
  computePriceUsdc,
  requireNumber,
  createApp,
  type AppConfig,
} from "./app.js";

// ---------------------------------------------------------------------------
// Test config — x402 middleware disabled so tests have no network dependency
// ---------------------------------------------------------------------------

const testConfig: AppConfig = {
  avmAddress: "TESTADDR0000000000000000000000000000000000000000000000000",
  facilitatorUrl: "http://localhost:9999", // not called: enableX402=false in tests
  publicBaseUrl: "http://localhost:5555",
  printerInfo: {
    printer_id: "test_printer",
    name: "Test Printer",
    location: { lat: 52.52, lon: 13.4, city: "Berlin" },
    capabilities: { materials: ["PLA", "PETG"], max_volume_cm3: 400 },
  },
  printerTimeMultiplier: 1.15,
  pricePerGram: 0.03,
  pricePerMinute: 0.005,
  flatFee: 0.1,
  canStartDelayMinutes: 20,
};

// ---------------------------------------------------------------------------
// Pure function tests — no network, no Hono
// ---------------------------------------------------------------------------

describe("computePrinterMinutes", () => {
  it("applies multiplier and rounds up", () => {
    expect(computePrinterMinutes(10, 1.15)).toBe(12);
  });

  it("identity multiplier returns same value", () => {
    expect(computePrinterMinutes(30, 1.0)).toBe(30);
  });

  it("rounds up fractional result", () => {
    // 7 * 1.15 = 8.05 → ceil = 9
    expect(computePrinterMinutes(7, 1.15)).toBe(9);
  });
});

describe("computePriceUsdc", () => {
  it("correct for known inputs", () => {
    // 10g * 0.03 + 12min * 0.005 + 0.10 = 0.30 + 0.06 + 0.10 = 0.46
    expect(computePriceUsdc(10, 12, 0.03, 0.005, 0.1)).toBe(0.46);
  });

  it("rounds up to 6 decimal places (USDC precision)", () => {
    // 1g * 0.03 + 1min * 0.005 + 0.1 = 0.135  → exact, no rounding needed
    expect(computePriceUsdc(1, 1, 0.03, 0.005, 0.1)).toBe(0.135);
  });

  it("applies flat fee even with zero grams and minutes", () => {
    expect(computePriceUsdc(0, 0, 0.03, 0.005, 0.1)).toBe(0.1);
  });
});

describe("requireNumber", () => {
  it("accepts valid numbers", () => {
    expect(requireNumber(5, "grams")).toBe(5);
    expect(requireNumber("3.14", "grams")).toBe(3.14);
    expect(requireNumber(0, "grams")).toBe(0);
  });

  it("rejects negative numbers", () => {
    expect(() => requireNumber(-1, "grams")).toThrow("Invalid numeric field: grams");
  });

  it("rejects NaN", () => {
    expect(() => requireNumber("abc", "grams")).toThrow("Invalid numeric field: grams");
  });

  it("rejects Infinity", () => {
    expect(() => requireNumber(Infinity, "grams")).toThrow("Invalid numeric field: grams");
  });
});

// ---------------------------------------------------------------------------
// HTTP endpoint tests via app.fetch (no real TCP socket)
// ---------------------------------------------------------------------------

const TEST_OPTS = { enableX402: false };

describe("GET /info", () => {
  it("returns printer metadata", async () => {
    const { app } = createApp(testConfig, TEST_OPTS);
    const res = await app.fetch(new Request("http://localhost/info"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.printer_id).toBe("test_printer");
    expect(body.name).toBe("Test Printer");
    expect(body.capabilities.materials).toContain("PLA");
  });
});

describe("POST /quote", () => {
  let app: ReturnType<typeof createApp>["app"];
  let paymentRequirements: ReturnType<typeof createApp>["paymentRequirements"];

  beforeEach(() => {
    const created = createApp(testConfig, TEST_OPTS);
    app = created.app;
    paymentRequirements = created.paymentRequirements;
  });

  function postQuote(body: Record<string, unknown>) {
    return app.fetch(
      new Request("http://localhost/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("returns 400 when job_id missing", async () => {
    const res = await postQuote({ grams: 10, minutes: 20, gcode_url: "http://x/a.gcode" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/job_id/i);
  });

  it("returns 400 when gcode_url missing", async () => {
    const res = await postQuote({ job_id: "j1", grams: 10, minutes: 20 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/gcode_url/i);
  });

  it("returns 400 when grams is negative", async () => {
    const res = await postQuote({ job_id: "j1", grams: -5, minutes: 20, gcode_url: "http://x/a.gcode" });
    expect(res.status).toBe(400);
  });

  it("returns 200 with can_start_at and payment_url", async () => {
    const res = await postQuote({
      job_id: "j_test_1",
      grams: 12,
      minutes: 40,
      gcode_url: "http://slicer/jobs/j_test_1.gcode",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payment_url).toBe("http://localhost:5555/pay/j_test_1");
    expect(typeof body.can_start_at).toBe("string");
    expect(new Date(body.can_start_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("registers payment requirement with JSON-serializable asset (no bigint)", async () => {
    await postQuote({
      job_id: "j_bigint",
      grams: 10,
      minutes: 30,
      gcode_url: "http://slicer/j_bigint.gcode",
    });

    const req = paymentRequirements["GET /pay/j_bigint"] as any;
    expect(req).toBeDefined();
    const asset = req.accepts[0].extra.asset;
    expect(typeof asset).toBe("number");
    // Must be JSON-serializable without throwing
    expect(() => JSON.stringify(req)).not.toThrow();
    expect(asset).toBe(10458941);
  });

  it("price is correct: 12g * 0.03 + ceil(40*1.15)=46min * 0.005 + 0.10", async () => {
    // printerMinutes = ceil(40 * 1.15) = ceil(46) = 46
    // price = 12*0.03 + 46*0.005 + 0.10 = 0.36 + 0.23 + 0.10 = 0.69
    const res = await postQuote({
      job_id: "j_price",
      grams: 12,
      minutes: 40,
      gcode_url: "http://slicer/j.gcode",
    });
    expect(res.status).toBe(200);
    const req = paymentRequirements["GET /pay/j_price"] as any;
    expect(req.accepts[0].price).toBe("$0.690000");
  });
});

describe("GET /pay/:job_id — payment lifecycle (x402 middleware disabled in unit tests)", () => {
  // Note: testing actual 402 enforcement requires a live x402 facilitator and is an
  // integration test. Here we verify the handler-level behaviour: job state transitions
  // and payment-requirement cleanup.

  it("returns 200 and marks job paid; removes payment requirement", async () => {
    const { app, paymentRequirements: reqs } = createApp(testConfig, TEST_OPTS);

    await app.fetch(
      new Request("http://localhost/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: "j_pay_lc",
          grams: 5,
          minutes: 10,
          gcode_url: "http://slicer/j_pay_lc.gcode",
        }),
      }),
    );

    expect(reqs["GET /pay/j_pay_lc"]).toBeDefined();

    const res = await app.fetch(new Request("http://localhost/pay/j_pay_lc"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("paid");
    expect(body.job_id).toBe("j_pay_lc");

    // Payment requirement must be removed to prevent replay
    expect(reqs["GET /pay/j_pay_lc"]).toBeUndefined();
  });
});

describe("GET /pay/:job_id — unknown job", () => {
  it("returns 404 for job that never received a quote", async () => {
    const { app } = createApp(testConfig, TEST_OPTS);
    const res = await app.fetch(new Request("http://localhost/pay/unknown_job"));
    expect(res.status).toBe(404);
  });
});

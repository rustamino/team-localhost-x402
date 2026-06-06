import "dotenv/config";

import { selectBestOffer, type PrinterOffer } from "./agenticOfferSelection.ts";

const userInstruction ="Choose the cheapest option out of Berlin-located printers which can strictly start within 2 hours.";

const mockOffers: PrinterOffer[] = [
  {
    printer_id: "printer_berlin_fast2",
    name: "BerlinPRNT",
    location: {
      lat: 52.52,
      lon: 13.4,
      city: "Berlin",
    },
    capabilities: {
      materials: ["PLA", "PETG"],
      max_volume_cm3: 400,
    },
    can_start_at: "2026-06-06T15:00:00Z",
    payment_url: "http://localhost:7001/pay/j_abc123",
    payment_required: {
      scheme: "algorand",
      address: "PRINTER_BERLIN_FAST_ADDRESS",
      amount: 850000, // 0.85 USDC
      asset: 10458941,
      nonce: "j_abc123",
    },
  },
  {
    printer_id: "printer_berlin_fast",
    name: "BerlinMaker FDM-1",
    location: {
      lat: 52.52,
      lon: 13.4,
      city: "Berlin",
    },
    capabilities: {
      materials: ["PLA", "PETG"],
      max_volume_cm3: 400,
    },
    can_start_at: "2026-06-06T15:00:00Z",
    payment_url: "http://localhost:7001/pay/j_abc123",
    payment_required: {
      scheme: "algorand",
      address: "PRINTER_BERLIN_FAST_ADDRESS",
      amount: 750000, // 0.75 USDC
      asset: 10458941,
      nonce: "j_abc123",
    },
  },
  {
    printer_id: "printer_berlin_cheap",
    name: "CheapPrint Berlin",
    location: {
      lat: 52.51,
      lon: 13.39,
      city: "Berlin",
    },
    capabilities: {
      materials: ["PLA"],
      max_volume_cm3: 300,
    },
    can_start_at: "2026-06-06T16:30:00Z",
    payment_url: "http://localhost:7002/pay/j_abc123",
    payment_required: {
      scheme: "algorand",
      address: "PRINTER_BERLIN_CHEAP_ADDRESS",
      amount: 520000, // 0.52 USDC
      asset: 10458941,
      nonce: "j_abc123",
    },
  },
  {
    printer_id: "printer_potsdam_cheapest",
    name: "Potsdam Print Lab",
    location: {
      lat: 52.39,
      lon: 13.06,
      city: "Potsdam",
    },
    capabilities: {
      materials: ["PLA", "PETG"],
      max_volume_cm3: 500,
    },
    can_start_at: "2026-06-06T14:30:00Z",
    payment_url: "http://localhost:7003/pay/j_abc123",
    payment_required: {
      scheme: "algorand",
      address: "PRINTER_POTSDAM_ADDRESS",
      amount: 390000, // 0.39 USDC
      asset: 10458941,
      nonce: "j_abc123",
    },
  },
];

async function main() {
  console.log("User instruction:");
  console.log(userInstruction);
  console.log();

  console.log("Mock printer offers:");
  for (const [index, offer] of mockOffers.entries()) {
    console.log(
      `[${index}] ${offer.name} | ${offer.location.city} | starts ${offer.can_start_at} | ` +
        `${offer.payment_required.amount / 1_000_000} USDC | ${offer.payment_url}`,
    );
  }

  console.log();
  console.log("Calling OpenAI offer-selection agent...");

  const decision = await selectBestOffer({
    instruction: userInstruction,
    offers: mockOffers,
  });

  console.log();
  console.log("Agent decision:");
  console.log(JSON.stringify(decision, null, 2));

  if (decision.selected_index === null) {
    console.log();
    console.log("No winning offer selected.");
    console.log("Reason:", decision.reason);
    return;
  }

  const winningOffer = mockOffers[decision.selected_index];

  console.log();
  console.log("Winning offer:");
  console.log(JSON.stringify(winningOffer, null, 2));

  console.log();
  console.log("Next step would be x402 payment to:");
  console.log(winningOffer.payment_url);
}

main().catch(error => {
  console.error("Mock offer selection failed:");
  console.error(error);
  process.exit(1);
});
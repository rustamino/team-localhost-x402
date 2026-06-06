/**
 * 03_watcher.ts — USDC incoming payment watcher with auto-refund
 *
 * Subscribes to incoming USDC transfers to the server address.
 * Matches by note prefix "order_", validates amount, and automatically
 * refunds any overpayment (> 5% tolerance) back to the sender.
 *
 * Uses AlgorandSubscriber (algokit) — polls algod every ~1s,
 * no indexer required in skip-sync-newest mode.
 */

import algosdk from "algosdk";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { AlgorandSubscriber } from "@algorandfoundation/algokit-subscriber";
import { SubscribedTransaction } from "@algorandfoundation/algokit-subscriber/types/subscription";
import { readFileSync } from "fs";
import { join } from "path";

const TESTNET_USDC_ASSET_ID = 10458941n;
const USDC_DECIMALS = 6;
const NOTE_PREFIX = "order_";
// Overpayments within tolerance are accepted silently; above it → refund excess
const OVERPAYMENT_TOLERANCE = 0.05;

// ── Order book (in-memory, replace with DB in production) ─────────────────
interface Order {
  orderId: string;
  expectedMicroUsdc: bigint;
  status: "pending" | "paid" | "overpaid" | "expired";
  createdAt: number;
  txId?: string;
  paidMicroUsdc?: bigint;
}

const orders = new Map<string, Order>();

function createOrder(orderId: string, amountUsdc: number): Order {
  const order: Order = {
    orderId,
    expectedMicroUsdc: BigInt(Math.round(amountUsdc * 10 ** USDC_DECIMALS)),
    status: "pending",
    createdAt: Date.now(),
  };
  orders.set(orderId, order);
  console.log(
    `[order] created ${orderId}: ${amountUsdc} USDC (${order.expectedMicroUsdc} micro)`
  );
  return order;
}

function onPaymentConfirmed(order: Order, txId: string) {
  const paid = Number(order.paidMicroUsdc!) / 10 ** USDC_DECIMALS;
  console.log(
    `\n✅ PAYMENT CONFIRMED: ${order.orderId}` +
      `\n   amount: ${paid.toFixed(6)} USDC` +
      `\n   tx:     ${txId}` +
      `\n   status: ${order.status}` +
      `\n   explorer: https://testnet.explorer.perawallet.app/tx/${txId}/\n`
  );
  // → here: unlock print job, notify WebSocket client, etc.
}

// ── Refund excess USDC to the original sender ──────────────────────────────
async function sendRefund(
  algorand: AlgorandClient,
  serverAccount: algosdk.Account,
  recipient: string,
  excessMicro: bigint,
  originalOrderId: string
): Promise<void> {
  const excessUsdc = Number(excessMicro) / 10 ** USDC_DECIMALS;
  console.log(
    `[refund] sending ${excessUsdc.toFixed(6)} USDC back to ${recipient.slice(0, 8)}…`
  );
  try {
    const result = await algorand.send.assetTransfer({
      sender: serverAccount.addr.toString(),
      receiver: recipient,
      assetId: TESTNET_USDC_ASSET_ID,
      amount: excessMicro,
      note: new TextEncoder().encode(`refund_${originalOrderId}`),
      signer: algosdk.makeBasicAccountTransactionSigner(serverAccount),
    });
    console.log(
      `[refund] ✓ sent ${excessUsdc.toFixed(6)} USDC` +
      `\n         tx: ${result.txIds[0]}` +
      `\n         explorer: https://testnet.explorer.perawallet.app/tx/${result.txIds[0]}/`
    );
  } catch (err) {
    console.error(`[refund] ✗ failed for ${originalOrderId}:`, err);
  }
}

// ── Transaction handler factory (captures server credentials) ─────────────
function makeHandler(algorand: AlgorandClient, serverAccount: algosdk.Account) {
  return async function handleIncomingUsdc(tx: SubscribedTransaction): Promise<void> {
    const noteBytes = tx.note;
    if (!noteBytes || noteBytes.length === 0) return;
    const note = new TextDecoder().decode(noteBytes).trim();
    if (!note.startsWith(NOTE_PREFIX)) return;

    const orderId = note;
    const amount = tx.assetTransferTransaction?.amount ?? 0n;
    const sender = tx.sender;
    const txId = tx.id;

    console.log(
      `[tx] received USDC transfer` +
        `\n     from:    ${sender}` +
        `\n     amount:  ${(Number(amount) / 10 ** USDC_DECIMALS).toFixed(6)} USDC` +
        `\n     note:    "${note}"` +
        `\n     tx:      ${txId}`
    );

    const order = orders.get(orderId);
    if (!order) {
      console.warn(`[warn] unknown order: ${orderId}`);
      return;
    }
    if (order.status !== "pending") {
      console.warn(`[warn] order ${orderId} already ${order.status}, ignoring`);
      return;
    }

    const expected = order.expectedMicroUsdc;
    const maxAccepted = BigInt(
      Math.ceil(Number(expected) * (1 + OVERPAYMENT_TOLERANCE))
    );

    if (amount < expected) {
      const got = (Number(amount) / 10 ** USDC_DECIMALS).toFixed(6);
      const exp = (Number(expected) / 10 ** USDC_DECIMALS).toFixed(6);
      console.warn(`[warn] underpayment for ${orderId}: got ${got}, expected ${exp}`);
      return;
    }

    order.txId = txId;
    order.paidMicroUsdc = amount;
    order.status = amount > maxAccepted ? "overpaid" : "paid";
    onPaymentConfirmed(order, txId);

    if (order.status === "overpaid") {
      const excess = amount - expected;
      await sendRefund(algorand, serverAccount, sender, excess, orderId);
    }
  };
}

// ── Watcher setup ──────────────────────────────────────────────────────────
async function startWatcher(serverAccount: algosdk.Account) {
  const algorand = AlgorandClient.testNet();
  const serverAddress = serverAccount.addr.toString();

  let watermark = 0n;

  const subscriber = new AlgorandSubscriber(
    {
      filters: [
        {
          name: "usdc-incoming",
          filter: {
            type: algosdk.TransactionType.axfer,
            assetId: TESTNET_USDC_ASSET_ID,
            receiver: serverAddress,
          },
        },
      ],
      syncBehaviour: "skip-sync-newest",
      waitForBlockWhenAtTip: true,
      frequencyInSeconds: 1,
      watermarkPersistence: {
        get: async () => watermark,
        set: async (w) => { watermark = w; },
      },
    },
    algorand.client.algod
  );

  subscriber.on("usdc-incoming", makeHandler(algorand, serverAccount));

  subscriber.onError((err) => {
    console.error("[watcher error]", err);
  });

  console.log(`[watcher] watching ${serverAddress.slice(0, 8)}… for USDC (ASA ${TESTNET_USDC_ASSET_ID})`);
  console.log(`[watcher] note prefix: "${NOTE_PREFIX}"`);
  console.log("[watcher] started — waiting for transactions...\n");

  subscriber.start();
  return subscriber;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const raw = readFileSync(join(__dirname, "accounts.json"), "utf-8");
  const accounts = JSON.parse(raw);
  const serverAccount = algosdk.mnemonicToSecretKey(accounts.server.mnemonic);
  const clientAccount = algosdk.mnemonicToSecretKey(accounts.client.mnemonic);

  const subscriber = await startWatcher(serverAccount);

  // Seed a few test orders
  createOrder("order_demo_001", 0.05);
  createOrder("order_demo_002", 0.20);

  const serverAddress = serverAccount.addr.toString();

  // After 3s: exact payment
  setTimeout(async () => {
    console.log("\n[test] sending 0.05 USDC for order_demo_001 (exact)...");
    const algorand = AlgorandClient.testNet();
    await algorand.send.assetTransfer({
      sender: clientAccount.addr.toString(),
      receiver: serverAddress,
      assetId: TESTNET_USDC_ASSET_ID,
      amount: 50000n,
      note: new TextEncoder().encode("order_demo_001"),
      signer: algosdk.makeBasicAccountTransactionSigner(clientAccount),
    });
  }, 3000);

  // After 8s: overpayment (+10%, above 5% tolerance → refund 0.02 USDC)
  setTimeout(async () => {
    console.log("\n[test] sending 0.22 USDC for order_demo_002 (expected 0.20, +10%)...");
    const algorand = AlgorandClient.testNet();
    await algorand.send.assetTransfer({
      sender: clientAccount.addr.toString(),
      receiver: serverAddress,
      assetId: TESTNET_USDC_ASSET_ID,
      amount: 220000n,
      note: new TextEncoder().encode("order_demo_002"),
      signer: algosdk.makeBasicAccountTransactionSigner(clientAccount),
    });
  }, 8000);

  // Run for 30s then stop
  setTimeout(async () => {
    console.log("\n[watcher] stopping.");
    await subscriber.stop("demo complete");
    process.exit(0);
  }, 30000);
}

main().catch(console.error);

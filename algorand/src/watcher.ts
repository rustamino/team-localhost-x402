import algosdk from "algosdk";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { AlgorandSubscriber } from "@algorandfoundation/algokit-subscriber";
import { SubscribedTransaction } from "@algorandfoundation/algokit-subscriber/types/subscription";
import { Config } from "./config";
import { OrderStore } from "./orders";

const USDC_DECIMALS = 6;

async function sendRefund(
  algorand: AlgorandClient,
  serverAccount: algosdk.Account,
  recipient: string,
  excessMicro: bigint,
  orderId: string,
  usdcAssetId: bigint
): Promise<string> {
  const result = await algorand.send.assetTransfer({
    sender: serverAccount.addr.toString(),
    receiver: recipient,
    assetId: usdcAssetId,
    amount: excessMicro,
    note: new TextEncoder().encode(`refund_${orderId}`),
    signer: algosdk.makeBasicAccountTransactionSigner(serverAccount),
  });
  return result.txIds[0];
}

export function createWatcher(config: Config, store: OrderStore): AlgorandSubscriber {
  const algorand = AlgorandClient.testNet();
  const serverAddress = config.serverAccount.addr.toString();

  let watermark = 0n;

  const subscriber = new AlgorandSubscriber(
    {
      filters: [
        {
          name: "usdc-incoming",
          filter: {
            type: algosdk.TransactionType.axfer,
            assetId: config.usdcAssetId,
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

  subscriber.on("usdc-incoming", async (tx: SubscribedTransaction) => {
    const noteBytes = tx.note;
    if (!noteBytes || noteBytes.length === 0) return;
    const note = new TextDecoder().decode(noteBytes).trim();
    if (!note.startsWith("order_")) return;

    const orderId = note;
    const amount = tx.assetTransferTransaction?.amount ?? 0n;
    const sender = tx.sender;
    const txId = tx.id;

    console.log(
      `[watcher] incoming ${(Number(amount) / 10 ** USDC_DECIMALS).toFixed(6)} USDC` +
      ` | order: ${orderId} | tx: ${txId}`
    );

    const order = store.get(orderId);
    if (!order) {
      console.warn(`[watcher] unknown order: ${orderId}`);
      return;
    }
    if (order.status !== "pending") {
      console.warn(`[watcher] order ${orderId} is ${order.status}, skipping`);
      return;
    }
    if (amount < order.expectedMicroUsdc) {
      console.warn(
        `[watcher] underpayment for ${orderId}: ` +
        `got ${amount}, expected ${order.expectedMicroUsdc}`
      );
      return;
    }

    const { refundMicro } = store.markPaid(
      orderId, txId, amount, sender, config.overpaymentTolerance
    );

    console.log(`[watcher] ✓ ${orderId} → ${order.status} (tx: ${txId})`);

    if (refundMicro !== null) {
      const excessUsdc = (Number(refundMicro) / 10 ** USDC_DECIMALS).toFixed(6);
      console.log(`[watcher] overpayment — refunding ${excessUsdc} USDC to ${sender.slice(0, 8)}…`);
      try {
        const refundTxId = await sendRefund(
          algorand, config.serverAccount, sender, refundMicro, orderId, config.usdcAssetId
        );
        store.markRefunded(orderId, refundTxId);
        console.log(`[watcher] ✓ refund sent (tx: ${refundTxId})`);
      } catch (err) {
        console.error(`[watcher] refund failed for ${orderId}:`, err);
      }
    }
  });

  subscriber.onError((err) => console.error("[watcher] error:", err));

  return subscriber;
}

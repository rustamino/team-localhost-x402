import { v4 as uuidv4 } from "uuid";

export type OrderStatus = "pending" | "paid" | "overpaid" | "expired" | "cancelled";

export interface Order {
  readonly orderId: string;
  readonly jobId: string;
  readonly expectedMicroUsdc: bigint;
  readonly createdAt: number;
  readonly expiresAt: number;
  status: OrderStatus;
  txId?: string;
  refundTxId?: string;
  paidMicroUsdc?: bigint;
  senderAddress?: string;
}

const USDC_DECIMALS = 6;

export class OrderStore {
  private orders = new Map<string, Order>();

  constructor(private readonly ttlSeconds: number) {}

  create(jobId: string, amountUsdc: number): Order {
    const orderId = `order_${uuidv4().replace(/-/g, "").slice(0, 12)}`;
    const expectedMicroUsdc = BigInt(Math.round(amountUsdc * 10 ** USDC_DECIMALS));
    const now = Date.now();
    const order: Order = {
      orderId,
      jobId,
      expectedMicroUsdc,
      createdAt: now,
      expiresAt: now + this.ttlSeconds * 1000,
      status: "pending",
    };
    this.orders.set(orderId, order);
    return order;
  }

  get(orderId: string): Order | undefined {
    const order = this.orders.get(orderId);
    if (!order) return undefined;
    if (order.status === "pending" && Date.now() > order.expiresAt) {
      order.status = "expired";
    }
    return order;
  }

  markPaid(
    orderId: string,
    txId: string,
    paidMicroUsdc: bigint,
    senderAddress: string,
    overpaymentTolerance: number
  ): { refundMicro: bigint | null } {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Order not found: ${orderId}`);
    if (order.status !== "pending") throw new Error(`Order ${orderId} is ${order.status}`);

    const maxAccepted = BigInt(
      Math.ceil(Number(order.expectedMicroUsdc) * (1 + overpaymentTolerance))
    );
    const needsRefund = paidMicroUsdc > maxAccepted;

    order.txId = txId;
    order.paidMicroUsdc = paidMicroUsdc;
    order.senderAddress = senderAddress;
    order.status = needsRefund ? "overpaid" : "paid";

    return { refundMicro: needsRefund ? paidMicroUsdc - order.expectedMicroUsdc : null };
  }

  markRefunded(orderId: string, refundTxId: string): void {
    const order = this.orders.get(orderId);
    if (order) order.refundTxId = refundTxId;
  }

  toJSON(order: Order) {
    return {
      order_id: order.orderId,
      job_id: order.jobId,
      status: order.status,
      amount_usdc: (Number(order.expectedMicroUsdc) / 10 ** USDC_DECIMALS).toFixed(6),
      expires_at: new Date(order.expiresAt).toISOString(),
      tx_id: order.txId ?? null,
      refund_tx_id: order.refundTxId ?? null,
      paid_usdc: order.paidMicroUsdc !== undefined
        ? (Number(order.paidMicroUsdc) / 10 ** USDC_DECIMALS).toFixed(6)
        : null,
    };
  }
}

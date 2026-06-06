import "dotenv/config";
import algosdk from "algosdk";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export interface Config {
  readonly port: number;
  readonly network: "testnet" | "mainnet";
  readonly serverAccount: algosdk.Account;
  readonly usdcAssetId: bigint;
  readonly orderTtlSeconds: number;
  readonly overpaymentTolerance: number;
}

function load(): Config {
  const network = optional("ALGO_NETWORK", "testnet");
  if (network !== "testnet" && network !== "mainnet") {
    throw new Error(`ALGO_NETWORK must be "testnet" or "mainnet", got: ${network}`);
  }

  const mnemonic = required("SERVER_MNEMONIC");
  const serverAccount = algosdk.mnemonicToSecretKey(mnemonic);

  const usdcAssetId = network === "mainnet" ? 31566704n : 10458941n;

  return Object.freeze({
    port: parseInt(optional("PORT", "3402"), 10),
    network,
    serverAccount,
    usdcAssetId,
    orderTtlSeconds: parseInt(optional("ORDER_TTL_SECONDS", "900"), 10),
    overpaymentTolerance: parseFloat(optional("OVERPAYMENT_TOLERANCE", "0.05")),
  });
}

export const config = load();

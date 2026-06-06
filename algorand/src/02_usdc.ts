/**
 * 02_usdc.ts — USDC opt-in and transfer on Algorand TestNet
 *
 * Demonstrates:
 *  - loading accounts from accounts.json
 *  - checking ALGO + USDC balances
 *  - opting into USDC ASA (required before receiving)
 *  - transferring USDC between accounts
 */

import algosdk from "algosdk";
import { AlgorandClient, algo } from "@algorandfoundation/algokit-utils";
import { readFileSync } from "fs";
import { join } from "path";

const TESTNET_USDC_ASSET_ID = 10458941n;
const USDC_DECIMALS = 6;

const algorand = AlgorandClient.testNet();

// ── Load accounts ──────────────────────────────────────────────────────────
function loadAccounts() {
  const raw = readFileSync(join(__dirname, "accounts.json"), "utf-8");
  const data = JSON.parse(raw) as {
    client: { address: string; mnemonic: string };
    server: { address: string; mnemonic: string };
  };

  const client = algosdk.mnemonicToSecretKey(data.client.mnemonic);
  const server = algosdk.mnemonicToSecretKey(data.server.mnemonic);

  return { client, server };
}

// ── Print balances ─────────────────────────────────────────────────────────
async function printBalances(label: string, address: string) {
  const info = await algorand.account.getInformation(address);
  const algo = (Number(info.amount) / 1e6).toFixed(6);
  const assets = info.assets ?? [];
  const usdc = assets.find((a) => BigInt(a.assetId) === TESTNET_USDC_ASSET_ID);
  const usdcBalance = usdc
    ? (Number(usdc.amount) / 10 ** USDC_DECIMALS).toFixed(6)
    : "not opted in";

  console.log(`${label} (${address.slice(0, 8)}…)`);
  console.log(`  ALGO:  ${algo}`);
  console.log(`  USDC:  ${usdcBalance}`);
  return { optedIn: !!usdc };
}

// ── Opt-in to USDC ASA ─────────────────────────────────────────────────────
async function optInUsdc(account: algosdk.Account) {
  console.log(`\nOpting ${account.addr.toString().slice(0, 8)}… into USDC...`);
  const result = await algorand.send.assetOptIn({
    sender: account.addr.toString(),
    assetId: TESTNET_USDC_ASSET_ID,
    signer: algosdk.makeBasicAccountTransactionSigner(account),
  });
  console.log(`  ✓ opt-in tx: ${result.txIds[0]}`);
}

// ── Transfer USDC ──────────────────────────────────────────────────────────
async function transferUsdc(
  from: algosdk.Account,
  to: string,
  amountUsdc: number,
  note?: string
) {
  const microUsdc = BigInt(Math.round(amountUsdc * 10 ** USDC_DECIMALS));
  console.log(`\nTransferring ${amountUsdc} USDC…`);

  const result = await algorand.send.assetTransfer({
    sender: from.addr.toString(),
    receiver: to,
    assetId: TESTNET_USDC_ASSET_ID,
    amount: microUsdc,
    note: note ? new TextEncoder().encode(note) : undefined,
    signer: algosdk.makeBasicAccountTransactionSigner(from),
  });

  console.log(`  ✓ transfer tx: ${result.txIds[0]}`);
  console.log(
    `  Explorer: https://testnet.explorer.perawallet.app/tx/${result.txIds[0]}/`
  );
  return result.txIds[0];
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const { client, server } = loadAccounts();

  console.log("=== Balances before ===");
  const clientState = await printBalances("client", client.addr.toString());
  const serverState = await printBalances("server", server.addr.toString());

  // Opt-in if needed
  if (!clientState.optedIn) await optInUsdc(client);
  if (!serverState.optedIn) await optInUsdc(server);

  console.log("\n=== Balances after opt-in ===");
  await printBalances("client", client.addr.toString());
  await printBalances("server", server.addr.toString());

  // Demo transfer: client → server, 0.10 USDC, note = "test_order_001"
  await transferUsdc(client, server.addr.toString(), 0.10, "test_order_001");

  console.log("\n=== Balances after transfer ===");
  await printBalances("client", client.addr.toString());
  await printBalances("server", server.addr.toString());
}

main().catch(console.error);

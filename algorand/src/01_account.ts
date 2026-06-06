/**
 * 01_account.ts — Algorand account basics
 *
 * Demonstrates:
 *  - generating a new account (keypair + mnemonic)
 *  - connecting to TestNet via AlgoKit
 *  - fetching account info (balance, opted-in assets)
 *  - checking USDC (ASA 10458941) balance
 */

import algosdk from "algosdk";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";

const TESTNET_USDC_ASSET_ID = 10458941n;

// ── Connect to TestNet (public AlgoNode endpoint) ──────────────────────────
const algorand = AlgorandClient.testNet();

// ── Generate a new random account ─────────────────────────────────────────
function generateAccount() {
  const account = algosdk.generateAccount();
  const mnemonic = algosdk.secretKeyToMnemonic(account.sk);

  const addr = account.addr.toString();
  console.log("=== New account ===");
  console.log("Address: ", addr);
  console.log("Mnemonic:", mnemonic);
  console.log("\nFund at:  https://bank.testnet.algorand.network/?account=" + addr);
  return account;
}

// ── Restore account from mnemonic ─────────────────────────────────────────
function restoreAccount(mnemonic: string) {
  const sk = algosdk.mnemonicToSecretKey(mnemonic);
  return sk; // { addr, sk }
}

// ── Fetch account info from TestNet ───────────────────────────────────────
async function fetchAccountInfo(address: string) {
  const info = await algorand.account.getInformation(address);

  const algoBalance = Number(info.amount) / 1e6;
  const minBalance = Number(info.minBalance) / 1e6;

  console.log("\n=== Account info:", address, "===");
  console.log(`ALGO balance:  ${algoBalance.toFixed(6)} ALGO`);
  console.log(`Min balance:   ${minBalance.toFixed(6)} ALGO`);
  console.log(`Status:        ${info.status}`);

  const assets = info.assets ?? [];
  if (assets.length === 0) {
    console.log("Assets:        none (not opted into any ASA)");
  } else {
    console.log("Assets:");
    for (const a of assets) {
      const idc = BigInt(a.assetId) === TESTNET_USDC_ASSET_ID ? " ← USDC" : "";
      console.log(
        `  ASA ${a.assetId}: ${a.amount} units${idc}`
      );
    }
  }

  return info;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  // Generate a fresh account for demo purposes
  const account = generateAccount();

  // Try to fetch info (will be "offline" with 0 balance until funded)
  try {
    await fetchAccountInfo(account.addr.toString());
  } catch (e: any) {
    // Account doesn't exist on-chain until it receives its first transaction
    console.log("\nAccount not yet on-chain (needs funding first).");
    console.log(
      "Fund at: https://bank.testnet.algorand.network/?account=" + account.addr
    );
  }

  // Example: restore from mnemonic (replace with a real funded mnemonic)
  // const mnemonic = "word1 word2 ... word25";
  // const funded = restoreAccount(mnemonic);
  // await fetchAccountInfo(funded.addr.toString());
}

main().catch(console.error);

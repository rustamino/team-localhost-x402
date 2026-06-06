/**
 * Algorand USDC refund: sends USDC back to the payer on testnet.
 *
 * Prerequisites for the printer's wallet:
 *   - opted into USDC ASA (asset 10458941)
 *   - holds enough USDC to cover the refund amount
 *
 * Set AVM_MNEMONIC in .env to enable real refunds.
 * Without it, refunds are logged but not submitted on-chain.
 */

import algosdk from "algosdk";
import { USDC_TESTNET_ASA_ID } from "@x402/avm";

const ALGOD_URL = process.env.ALGOD_URL ?? "https://testnet-api.algonode.cloud";

export async function refundUsdc(
  toAddress: string,
  amountUsdc: number,
  mnemonic: string,
): Promise<string> {
  const account = algosdk.mnemonicToSecretKey(mnemonic);
  const algod = new algosdk.Algodv2("", ALGOD_URL, "");

  const params = await algod.getTransactionParams().do();
  const microUsdc = BigInt(Math.round(amountUsdc * 1_000_000));

  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: account.addr.toString(),
    receiver: toAddress,
    assetIndex: Number(USDC_TESTNET_ASA_ID),
    amount: microUsdc,
    suggestedParams: params,
  });

  const signedTxn = txn.signTxn(account.sk);
  const { txid } = await algod.sendRawTransaction(signedTxn).do();
  console.log(`[refund] submitted txid: ${txid}`);
  return txid;
}

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { USDC_TESTNET_ASA_ID } from "@x402/avm";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";

const rl = readline.createInterface({ input, output });
const mnemonic = (await rl.question("Enter 25-word mnemonic: ")).trim();
rl.close();

try {
  const algorand = AlgorandClient.testNet();
  const account = algorand.account.fromMnemonic(mnemonic);
  console.log(`Address: ${account.addr}`);

  const result = await algorand.send.assetOptIn({
    sender: account.addr,
    signer: account.signer,
    assetId: BigInt(USDC_TESTNET_ASA_ID),
  });

  console.log("Asset opt-in successful");
  console.log("Transaction ID:", result.txId);
} catch (error) {
  console.error("Asset opt-in failed:");
  console.error(error);
}
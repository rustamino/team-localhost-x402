import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { AlgoAmount } from "@algorandfoundation/algokit-utils/types/amount";

const rl = readline.createInterface({ input, output });

const mnemonic = (await rl.question("Enter sender 25-word mnemonic: ")).trim();
const receiverAddress = (await rl.question("Enter receiver ADDRESS: ")).trim();
const amountAlgoText = (await rl.question("Enter amount in ALGO: ")).trim();

rl.close();

try {
  const amountAlgo = Number(amountAlgoText);

  if (!Number.isFinite(amountAlgo) || amountAlgo <= 0) {
    throw new Error("Amount must be a positive number");
  }

  const amountMicroAlgo = Math.round(amountAlgo * 1_000_000);

  const algorand = AlgorandClient.testNet();
  const senderAccount = algorand.account.fromMnemonic(mnemonic);

  console.log(`Sender address:   ${senderAccount.addr}`);
  console.log(`Receiver address: ${receiverAddress}`);
  console.log(`Amount:           ${amountAlgo} ALGO`);
  console.log(`MicroALGO:        ${amountMicroAlgo}`);

  const result = await algorand.send.payment({
    sender: senderAccount.addr,
    signer: senderAccount.signer,
    receiver: receiverAddress,
    amount: AlgoAmount.MicroAlgos(amountMicroAlgo),
  });

  console.log("ALGO transfer successful");
  console.log("Transaction ID:", result.txId ?? result.txIds?.[0]);
} catch (error) {
  console.error("ALGO transfer failed:");
  console.error(error);
}
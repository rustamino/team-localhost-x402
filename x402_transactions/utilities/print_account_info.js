import algosdk from "algosdk";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const rl = readline.createInterface({ input, output });

const address = (await rl.question("Enter ADDRESS: ")).trim();

rl.close();

const algodClient = new algosdk.Algodv2(
  "",
  "https://testnet-api.algonode.cloud",
  ""
);

try {
  const accountInfo = await algodClient.accountInformation(address).do();
  console.log(accountInfo);
} catch (error) {
  console.error("Failed to fetch account info:");
  console.error(error);
}
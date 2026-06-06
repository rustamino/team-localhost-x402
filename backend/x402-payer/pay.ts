/**
 * pay.ts — one-shot x402 payer (called as a subprocess by the Python backend)
 *
 * Pays the URL of the printer offer the user selected. The URL points at a
 * printer's x402-protected route (GET /pay/{job_id}): the first request returns
 * 402, `wrapFetchWithPayment` then signs a USDC payment on Algorand testnet with
 * the merchant/agent mnemonic and retries automatically.
 *
 * Usage:
 *   node --import tsx pay.ts <payment_url>
 *
 * Output contract (so Python can always parse it):
 *   - exactly one JSON object is written to STDOUT (the result)
 *   - all human-readable logs go to STDERR
 *
 * Success: { "ok": true,  "payer": "<addr>", "settle": {...}, "resource": {...} }
 * Failure: { "ok": false, "error": "<message>", ...extra }
 */

import { config } from 'dotenv';
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from '@x402/fetch';
import { toClientAvmSigner, ExactAvmScheme, ALGORAND_TESTNET_CAIP2 } from '@x402/avm';
import {
  ed25519SigningKeyFromWrappedSecret,
  type WrappedEd25519Seed,
} from '@algorandfoundation/algokit-utils/crypto';
import { seedFromMnemonic } from '@algorandfoundation/algokit-utils/algo25';

config();

const paymentUrl = process.argv[2];
const avmMnemonic = process.env.AVM_MNEMONIC;

function emit(result: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(result) + '\n');
}

function fail(error: string, extra: Record<string, unknown> = {}): never {
  emit({ ok: false, error, ...extra });
  process.exit(1);
}

async function main(): Promise<void> {
  if (!paymentUrl) fail('Missing payment_url argument');
  if (!avmMnemonic) fail('Missing AVM_MNEMONIC env var (set it in x402-payer/.env)');

  const secretKey = await getSecretKeyFromMnemonic(avmMnemonic);

  // The Algorand signer that authorizes the USDC payment.
  const avmSigner = toClientAvmSigner(secretKey);

  const client = new x402Client();
  client.register(ALGORAND_TESTNET_CAIP2, new ExactAvmScheme(avmSigner));

  console.error(`[payer] signer:  ${avmSigner.address}`);
  console.error(`[payer] paying:  ${paymentUrl}`);

  // Wrap fetch so a 402 response triggers payment + retry automatically.
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  const response = await fetchWithPayment(paymentUrl, { method: 'GET' });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    fail(`Payment not settled (HTTP ${response.status})`, {
      status: response.status,
      body,
    });
  }

  // Settlement receipt from the X-PAYMENT-RESPONSE header (carries the tx id).
  const settle = new x402HTTPClient(client).getPaymentSettleResponse(name =>
    response.headers.get(name),
  );

  let resource: unknown = null;
  try {
    resource = await response.json();
  } catch {
    resource = null;
  }

  console.error('[payer] payment settled');
  emit({ ok: true, payer: avmSigner.address, settle, resource });
}

// Build the base64-encoded signing key that x402-avm expects.
// Format = 32-byte Ed25519 seed + 32-byte public key.
async function getSecretKeyFromMnemonic(mnemonic: string): Promise<string> {
  const seed = seedFromMnemonic(mnemonic);
  const seedCopy = new Uint8Array(seed);

  const wrappedSeed: WrappedEd25519Seed = {
    unwrapEd25519Seed: async () => seed,
    wrapEd25519Seed: async () => {},
  };

  const wrappedSecret = await ed25519SigningKeyFromWrappedSecret(wrappedSeed);

  return Buffer.concat([
    Buffer.from(seedCopy),
    Buffer.from(wrappedSecret.ed25519Pubkey),
  ]).toString('base64');
}

main().catch(error => {
  fail(error?.response?.data?.error ?? error?.message ?? String(error));
});

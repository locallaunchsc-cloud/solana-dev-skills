/**
 * swap.ts — execute a full Jupiter swap on Solana mainnet.
 *
 * Flow:
 *   1. Load keypair from KEYPAIR_PATH (a JSON array of 64 bytes, as `solana-keygen` writes).
 *   2. GET /swap/v1/quote for inputMint -> outputMint, amount, slippageBps.
 *   3. POST /swap/v1/swap with the quote + priority-fee + dynamic-slippage options.
 *   4. Deserialize the returned base64 v0 VersionedTransaction, sign, send.
 *   5. Confirm to "confirmed" commitment, print Solscan link.
 *
 * Usage:
 *   export KEYPAIR_PATH=$HOME/.config/solana/id.json     # never commit this file
 *   export RPC_URL=https://your-staked-connection-rpc    # do NOT use api.mainnet-beta.solana.com
 *   npx tsx scripts/swap.ts
 *
 * Deps:
 *   npm i @solana/web3.js@^1.98.4 @jup-ag/api@^6.0.48
 *
 * Tested against Jupiter Swap API v1 (https://api.jup.ag/swap/v1) — May 2026.
 */

import fs from "node:fs";
import {
  Connection,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";

// ── Config ──────────────────────────────────────────────────────────────────

// Keyless free tier. Replace with "https://api.jup.ag" and add x-api-key header for paid.
const JUP_HOST = "https://lite-api.jup.ag";

// IMPORTANT: do not commit keypair files. Read from env or a path outside the repo.
const KEYPAIR_PATH = process.env.KEYPAIR_PATH ?? `${process.env.HOME}/.config/solana/id.json`;

// IMPORTANT: api.mainnet-beta.solana.com is rate-limited and unreliable for sendRawTransaction.
// Use a staked-connection RPC (Helius / Triton / QuickNode / Shyft).
const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";

// TODO: adjust for your trade.
const INPUT_MINT  = "So11111111111111111111111111111111111111112";   // SOL
const OUTPUT_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";  // USDC
const AMOUNT_ATOMIC = String(0.01 * 1e9);  // 0.01 SOL, in lamports
const SLIPPAGE_BPS = 50;                   // 0.5% cap (dynamicSlippage will pick under this)

// Cap how much priority fee Jupiter is allowed to add automatically (0.01 SOL).
const MAX_PRIORITY_LAMPORTS = 10_000_000;

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadKeypair(path: string): Keypair {
  const raw = fs.readFileSync(path, "utf8");
  const bytes = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(bytes);
}

async function getQuote(): Promise<any> {
  const qs = new URLSearchParams({
    inputMint: INPUT_MINT,
    outputMint: OUTPUT_MINT,
    amount: AMOUNT_ATOMIC,
    slippageBps: String(SLIPPAGE_BPS),
  });
  const res = await fetch(`${JUP_HOST}/swap/v1/quote?${qs}`);
  if (!res.ok) throw new Error(`quote ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getSwapTx(quote: any, userPubkey: string): Promise<string> {
  const body = {
    quoteResponse: quote,
    userPublicKey: userPubkey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    dynamicSlippage: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports: MAX_PRIORITY_LAMPORTS,
        priorityLevel: "veryHigh",
      },
    },
  };
  const res = await fetch(`${JUP_HOST}/swap/v1/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`swap ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.swapTransaction as string;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const wallet = loadKeypair(KEYPAIR_PATH);
  const connection = new Connection(RPC_URL, "confirmed");

  const startBalance = await connection.getBalance(wallet.publicKey);
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`Start SOL balance: ${startBalance / 1e9}`);

  // 1. Quote
  const quote = await getQuote();
  console.log(`Quoted ${quote.inAmount} -> ${quote.outAmount}  (impact ${(Number(quote.priceImpactPct) * 100).toFixed(3)}%, route hops: ${quote.routePlan.length})`);

  // 2. Build swap tx
  const swapTxB64 = await getSwapTx(quote, wallet.publicKey.toBase58());

  // 3. Sign — Jupiter always returns a v0 VersionedTransaction.
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTxB64, "base64"));
  tx.sign([wallet]);

  // 4. Send. skipPreflight is safe because dynamicComputeUnitLimit already simulated.
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 0,
  });
  console.log(`Sent: https://solscan.io/tx/${sig}`);

  // 5. Confirm against the tx's own blockhash (read from the message).
  const blockhash = tx.message.recentBlockhash;
  const latest = await connection.getLatestBlockhash("confirmed");
  const status = await connection.confirmTransaction(
    {
      signature: sig,
      blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed",
  );
  if (status.value.err) {
    throw new Error(`Swap failed on-chain: ${JSON.stringify(status.value.err)}`);
  }

  const endBalance = await connection.getBalance(wallet.publicKey);
  console.log(`End SOL balance:   ${endBalance / 1e9}`);
  console.log(`Confirmed. https://solscan.io/tx/${sig}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

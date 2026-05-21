/**
 * priority-fee.ts — call Helius getPriorityFeeEstimate and apply it to a tx.
 *
 * Usage:
 *   HELIUS_API_KEY=xxx tsx scripts/priority-fee.ts
 *
 * What it shows:
 *   1. Polling getPriorityFeeEstimate by account list (the common case — you
 *      know which writable accounts your tx will touch).
 *   2. Asking for either a single `recommended` number OR the full
 *      {min, low, medium, high, veryHigh, unsafeMax} histogram.
 *   3. Wiring the result into a real sendTransaction call with
 *      ComputeBudgetProgram.setComputeUnitPrice — including the gotcha that
 *      the returned value is in microLamports (NOT lamports).
 *
 * Send path uses @solana/web3.js for clarity. The same numeric result drops
 * into @solana/kit's createTransactionMessage / appendTransactionMessageInstruction.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const API_KEY = process.env.HELIUS_API_KEY;
if (!API_KEY) {
  console.error("Set HELIUS_API_KEY (get one at https://dashboard.helius.dev)");
  process.exit(1);
}

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

// --- types --------------------------------------------------------------------

interface PriorityFeeLevels {
  min: number;
  low: number;
  medium: number;
  high: number;
  veryHigh: number;
  unsafeMax: number;
}

interface PriorityFeeResponse {
  priorityFeeEstimate?: number;
  priorityFeeLevels?: PriorityFeeLevels;
}

// --- core call ----------------------------------------------------------------

/**
 * Get a priority fee estimate (in microLamports) for a set of writable accounts.
 *
 * @param accountKeys  The writable accounts your transaction will touch. Helius
 *                     samples recent fees from transactions that touched any of
 *                     these accounts. Pass the SAME pubkeys you'd put in your
 *                     instructions — at minimum the fee payer and any token
 *                     accounts you're mutating.
 * @param wantHistogram If true, returns the full level breakdown instead of one
 *                      number. Useful for showing the user a fee picker.
 */
async function getPriorityFee(
  accountKeys: string[],
  wantHistogram = false,
): Promise<PriorityFeeResponse> {
  const options = wantHistogram
    ? { includeAllPriorityFeeLevels: true }
    : { recommended: true };

  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "getPriorityFeeEstimate",
      params: [{ accountKeys, options }],
    }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as {
    result?: PriorityFeeResponse;
    error?: { message: string };
  };
  if (body.error) throw new Error(`Helius: ${body.error.message}`);
  if (!body.result) throw new Error("Empty result");
  return body.result;
}

// --- demo: inspect the histogram for a hot account ----------------------------

async function showHistogram() {
  // Jupiter v6 aggregator — extremely active, gives a realistic spread.
  const HOT_ACCOUNT = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

  console.log("Asking Helius for the full priority-fee histogram...\n");
  const { priorityFeeLevels } = await getPriorityFee([HOT_ACCOUNT], true);
  if (!priorityFeeLevels) {
    console.error("No levels returned");
    return;
  }

  console.log("Priority fee levels (units: microLamports per CU):");
  for (const [level, value] of Object.entries(priorityFeeLevels)) {
    console.log(`  ${level.padEnd(11)} ${value.toLocaleString()} µLamports/CU`);
  }
  console.log(
    "\nReminder: these are MICROLAMPORTS (1e-6 lamports). Pass them straight to",
  );
  console.log("ComputeBudgetProgram.setComputeUnitPrice({ microLamports: ... }) — do NOT multiply.");
}

// --- demo: build + send a real transaction with the recommended fee ----------

async function sendWithRecommendedFee() {
  // Replace with your own funded keypair on devnet for a live test.
  // For the demo we just build the tx and print it instead of broadcasting.
  const payer = Keypair.generate();
  const recipient = Keypair.generate().publicKey;

  // 1. Ask Helius what to pay. We pass the writable accounts for THIS tx:
  //    the system program is not writable, but the payer and recipient are.
  const accountKeys = [payer.publicKey.toBase58(), recipient.toBase58()];
  const { priorityFeeEstimate } = await getPriorityFee(accountKeys);
  if (priorityFeeEstimate === undefined) {
    throw new Error("Helius returned no priorityFeeEstimate");
  }

  console.log(
    `\nRecommended priority fee: ${priorityFeeEstimate.toLocaleString()} µLamports/CU`,
  );

  // 2. Build a normal transfer.
  const connection = new Connection(RPC_URL, "confirmed");
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

  const tx = new Transaction({
    feePayer: payer.publicKey,
    blockhash,
    lastValidBlockHeight,
  });

  // 3. ComputeBudget instructions MUST come first in the tx.
  //    setComputeUnitPrice takes microLamports — the Helius response, verbatim.
  //    setComputeUnitLimit caps the CUs you'll buy (and pay for).
  //    Helius value × CU limit = max priority fee in lamports.
  //    e.g. 50_000 µLamports × 200_000 CU = 10_000_000_000 µLamports
  //                                       = 10_000 lamports = 0.00001 SOL.
  tx.add(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFeeEstimate, // <-- direct, do not convert
    }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports: 1000,
    }),
  );

  console.log(`Transaction built with ${tx.instructions.length} instructions:`);
  for (const ix of tx.instructions) {
    console.log(`  - ${ix.programId.toBase58()}`);
  }

  // Uncomment to actually broadcast (and fund `payer` first):
  // const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
  // console.log("Sent:", sig);

  // Silence the unused-import warning for the demo path.
  void sendAndConfirmTransaction;
  void PublicKey;
}

async function main() {
  await showHistogram();
  await sendWithRecommendedFee();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

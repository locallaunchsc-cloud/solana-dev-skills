/**
 * quote-only.ts — get a Jupiter quote without signing or sending anything.
 *
 * Usage:
 *   npx tsx scripts/quote-only.ts                          # uses defaults (0.1 SOL -> USDC)
 *   npx tsx scripts/quote-only.ts <inputMint> <outputMint> <amountAtomic> [slippageBps]
 *
 * Example:
 *   npx tsx scripts/quote-only.ts \
 *     So11111111111111111111111111111111111111112 \
 *     EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
 *     100000000 50
 *
 * Deps: none beyond Node 20+ (uses global fetch). No keypair needed.
 */

// Use the keyless free endpoint. Swap to "https://api.jup.ag" + x-api-key header for paid tier.
const JUP_HOST = "https://lite-api.jup.ag";

// Well-known mints for convenience.
const SOL_MINT  = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// TODO: adjust defaults for your test pair. amount is in ATOMIC units of inputMint.
const DEFAULT_INPUT  = SOL_MINT;
const DEFAULT_OUTPUT = USDC_MINT;
const DEFAULT_AMOUNT = String(0.1 * 1e9); // 0.1 SOL
const DEFAULT_SLIPPAGE_BPS = "50";        // 0.5%

interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
    percent: number;
  }>;
  contextSlot: number;
  timeTaken: number;
}

async function getQuote(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: string,
): Promise<QuoteResponse> {
  const qs = new URLSearchParams({ inputMint, outputMint, amount, slippageBps });
  const url = `${JUP_HOST}/swap/v1/quote?${qs}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Quote failed ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<QuoteResponse>;
}

async function main() {
  const [, , inputMint, outputMint, amount, slippageBps] = process.argv;
  const q = await getQuote(
    inputMint    ?? DEFAULT_INPUT,
    outputMint   ?? DEFAULT_OUTPUT,
    amount       ?? DEFAULT_AMOUNT,
    slippageBps  ?? DEFAULT_SLIPPAGE_BPS,
  );

  console.log("=== Jupiter Quote ===");
  console.log(`Input:           ${q.inAmount} of ${q.inputMint}`);
  console.log(`Output:          ${q.outAmount} of ${q.outputMint}`);
  console.log(`Min received:    ${q.otherAmountThreshold} (after ${q.slippageBps} bps slippage)`);
  console.log(`Price impact:    ${(Number(q.priceImpactPct) * 100).toFixed(4)}%`);
  console.log(`Context slot:    ${q.contextSlot}`);
  console.log(`Time taken (ms): ${q.timeTaken}`);
  console.log(`\nRoute (${q.routePlan.length} hop${q.routePlan.length === 1 ? "" : "s"}):`);
  for (const [i, step] of q.routePlan.entries()) {
    const s = step.swapInfo;
    console.log(`  ${i + 1}. [${step.percent}%] ${s.label}: ${s.inAmount} ${s.inputMint.slice(0, 4)}… -> ${s.outAmount} ${s.outputMint.slice(0, 4)}…`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

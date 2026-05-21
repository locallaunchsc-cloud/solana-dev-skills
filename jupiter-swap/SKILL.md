---
name: solana-jupiter-swap
description: Use this skill when the user wants to integrate Jupiter — Solana's leading DEX aggregator — to get quotes and execute swaps with slippage control, priority fees, and versioned transactions.
---

# Jupiter Swap

## Overview
Jupiter is the default DEX aggregator on Solana: it routes a single swap across dozens of DEXes (Orca, Raydium, Meteora, Phoenix, etc.) and RFQ market makers to give the user the best price. As of May 2026 the stable HTTP surface is the **Swap V1 API** at `https://api.jup.ag/swap/v1` (requires a free API key from `portal.jup.ag`) or the keyless mirror at `https://lite-api.jup.ag/swap/v1` for low-volume use. A newer **Swap V2** unified router (`/swap/v2/order`, `/build`, `/execute`) launched in March 2026 and is the recommended target for new production systems, but V1 is still the most stable, broadly-supported path and what almost every example online uses. This skill covers V1, with a note on the V2 migration.

## When to use this skill
- The user asks "how do I swap tokens on Solana"
- The user mentions Jupiter, JUP, "DEX aggregator", "best price routing"
- They want to buy/sell an SPL token from a script, bot, or backend
- They need to embed swaps inside a larger Solana program flow (e.g. claim → swap → stake)
- They're hitting slippage / blockhash / priority-fee problems on a swap they already wrote

Skip this skill if the user wants an on-chain CPI call into Jupiter (use Jupiter's IDL + Anchor instead) or only wants a price feed (use `/price` or Pyth).

## Prerequisites
- Node 20+ (LTS) — `node -v` should report ≥ 20.x
- `npm i @solana/web3.js@^1.98.4 @jup-ag/api@^6.0.48` (or pin exact versions)
- A Solana RPC endpoint. The public `https://api.mainnet-beta.solana.com` is rate-limited and will get you 429s — use a **staked-connection** RPC (Helius, Triton, QuickNode, Shyft) for anything past hello-world.
- A funded mainnet keypair (`~0.05 SOL` minimum for rent + fees on top of the swap amount)
- For `api.jup.ag`: a free API key from https://portal.jup.ag. For `lite-api.jup.ag`: nothing.

## Workflow

### 1. Get a quote — `GET /swap/v1/quote`
Quote endpoint takes `inputMint`, `outputMint`, `amount` (atomic units of the **input** mint), and `slippageBps` (1% = 100 bps).

```ts
const QUOTE_HOST = "https://lite-api.jup.ag"; // or "https://api.jup.ag" with x-api-key
const SOL  = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const qs = new URLSearchParams({
  inputMint: SOL,
  outputMint: USDC,
  amount: String(0.1 * 1e9), // 0.1 SOL in lamports
  slippageBps: "50",         // 0.5%
});
const quote = await fetch(`${QUOTE_HOST}/swap/v1/quote?${qs}`).then(r => r.json());
```

### 2. Quote response anatomy
Fields you actually use:
- `inAmount` / `outAmount` — atomic units, both as decimal strings
- `otherAmountThreshold` — the floor you'll receive after `slippageBps` is applied (this is the on-chain guard)
- `priceImpactPct` — string like `"0.0012"` (0.12%). Bail above ~1–2% on a normal pair.
- `routePlan` — array of hops. `routePlan[i].swapInfo.label` tells you which DEX (`"Orca (Whirlpools)"`, `"Raydium CLMM"`, …).
- `contextSlot` — slot the quote was priced against. If you delay >~10s before posting, refetch.

### 3. Get the swap transaction — `POST /swap/v1/swap`
Send the **entire `quote` object back** as `quoteResponse`. Don't try to reconstruct it.

```ts
const swapBody = {
  quoteResponse: quote,
  userPublicKey: wallet.publicKey.toBase58(),
  wrapAndUnwrapSol: true,            // creates/closes the wSOL ATA for you
  dynamicComputeUnitLimit: true,     // simulates to size CU exactly
  dynamicSlippage: true,             // lets Jupiter pick slippage at build time (V1 feature)
  prioritizationFeeLamports: {
    priorityLevelWithMaxLamports: {
      maxLamports: 10_000_000,       // 0.01 SOL cap — adjust per asset
      priorityLevel: "veryHigh",
    },
  },
};
const { swapTransaction } = await fetch(`${QUOTE_HOST}/swap/v1/swap`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(swapBody),
}).then(r => r.json());
```

### 4. Sign and send a versioned transaction
Jupiter **always** returns a v0 `VersionedTransaction` (it relies on address lookup tables — there is no legacy path that fits the route). Don't try to convert it to a legacy Transaction.

```ts
import { VersionedTransaction } from "@solana/web3.js";

const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
tx.sign([wallet]);

const sig = await connection.sendRawTransaction(tx.serialize(), {
  skipPreflight: true,    // we already simulated via dynamicComputeUnitLimit
  maxRetries: 0,          // we'll handle retries ourselves
});
```

### 5. Confirm and decode logs
Use the same blockhash that's already inside the tx — `getLatestBlockhash` here is just for the confirmation strategy.

```ts
const latest = await connection.getLatestBlockhash("confirmed");
const status = await connection.confirmTransaction(
  { signature: sig, ...latest },
  "confirmed",
);
if (status.value.err) throw new Error(`Swap failed: ${JSON.stringify(status.value.err)}`);
console.log(`https://solscan.io/tx/${sig}`);
```

### 6. Priority fees — auto vs manual
Two patterns:
- **Auto (recommended):** `prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports, priorityLevel: "veryHigh" } }`. Jupiter samples the fee market via Triton and picks. Cap at something sane so a fee spike doesn't drain you.
- **Manual:** `prioritizationFeeLamports: 5_000_000` (flat lamports) or set `computeUnitPriceMicroLamports` yourself. Only do this if you're running your own fee oracle.

### 7. Dynamic slippage
`dynamicSlippage: true` lets Jupiter set `otherAmountThreshold` at build time based on observed volatility for that pair. The `slippageBps` in your quote becomes a *cap*. This is almost always what you want for production. Disable it if you're arb-ing and want exact behavior.

### 8. Token list / verified mints
Always verify the mint addresses you're swapping. Use the Jupiter strict token list at `https://tokens.jup.ag/tokens?tags=verified` (or `lite-api.jup.ag/tokens/v1/...`). Passing a random mint that looks like USDC but isn't will route — and you'll receive a worthless token.

## Common pitfalls

1. **`6001: Slippage exceeded`** — price moved between quote and execution. Either raise `slippageBps` (50 → 100 → 300 for thin tokens), turn on `dynamicSlippage: true`, or refetch the quote right before sending.

2. **`BlockhashNotFound` / `Transaction was not confirmed in 30.00 seconds`** — the blockhash baked into Jupiter's tx is ~60–90s lived. If you sat on `swapTransaction` too long, throw it away and call `/swap` again. Don't try to swap out the blockhash on the v0 tx — re-fetch.

3. **`InsufficientFundsForRent` even though you have SOL** — Jupiter's swap amount is taken from your balance *and* you still pay the priority fee and possibly a 0.00203928 SOL rent deposit for a new ATA. Keep ~0.05 SOL clear above the swap amount on mainnet.

4. **Wrapped SOL ATA missing** — if `wrapAndUnwrapSol: false`, you must create the wSOL ATA yourself before swapping out of SOL. Just leave it `true` unless you're aggregating multiple swaps and managing wSOL across them.

5. **"Why won't `asLegacyTransaction` work?"** — it can't. Real Jupiter routes touch enough accounts that they only fit inside a v0 tx with Address Lookup Tables. Use `VersionedTransaction.deserialize`, not `Transaction.from`.

6. **Public RPC 429s mid-flight** — `api.mainnet-beta.solana.com` will silently drop your `sendRawTransaction` under load and you'll think the swap "didn't go through" when it did. Use a staked-connection RPC (Helius, Triton, QuickNode). Verify by querying the signature.

7. **Decimals mismatch** — `amount` is **atomic units of `inputMint`**, not human units. 1 USDC is `1_000_000` (6 decimals), 1 SOL is `1_000_000_000` (9 decimals). Multiply by `10 ** mint.decimals`, never assume.

## References
- Jupiter Developer Docs: https://dev.jup.ag (redirects to https://developers.jup.ag)
- Swap V1 quote: https://developers.jup.ag/docs/swap/get-quote
- Swap V1 send: https://developers.jup.ag/docs/swap/send-swap-transaction
- API base (paid): `https://api.jup.ag`  •  API key portal: https://portal.jup.ag
- API base (free, keyless): `https://lite-api.jup.ag`
- `@jup-ag/api` (typed client): https://www.npmjs.com/package/@jup-ag/api
- GitHub org: https://github.com/jup-ag
- Discord: https://discord.gg/jup

## Example scripts
See `scripts/quote-only.ts` for a read-only quote and `scripts/swap.ts` for a full executed swap.

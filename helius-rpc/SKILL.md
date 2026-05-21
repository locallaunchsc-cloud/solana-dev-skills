---
name: solana-helius-rpc
description: Use this skill when the user wants high-throughput Solana RPC access via Helius — standard RPC, DAS (Digital Asset Standard) NFT/token queries, transaction webhooks, enhanced transaction parsing, and priority fee estimation.
---

# Helius RPC

## Overview
Helius is the dominant production RPC provider on Solana. Beyond standard JSON-RPC (`getBalance`, `sendTransaction`, etc.), Helius layers on a set of APIs that the base Agave validator does not expose: the DAS API (one unified query surface for NFTs, compressed NFTs, and SPL tokens), enhanced transaction parsing (human-readable swap/transfer/mint events), real-time webhooks (push deliveries when watched accounts move), and `getPriorityFeeEstimate` (the de-facto way to size compute-unit-price on mainnet). If you are building anything beyond a toy, you will almost certainly call at least two of these.

## When to use this skill
- The user mentions Helius, Helius RPC, DAS API, Helius webhooks, or `getPriorityFeeEstimate`.
- The user wants to fetch a wallet's NFTs / cNFTs / tokens in one call (use DAS, not `getTokenAccountsByOwner`).
- The user needs a push notification when a Solana account changes state.
- The user is sending mainnet transactions and asks about priority fees / CU price / landing rate.
- The user needs parsed/decoded transaction history (who swapped what, mint events, sales) rather than raw byte instructions.

## Prerequisites
- Helius account + API key from https://dashboard.helius.dev (the free Developer tier is fine to start; the credit and RPS limits scale on Pro / Business plans).
- Node 20+ (the SDK targets modern Node and uses native `fetch`).
- One of:
  - `npm install helius-sdk@^2.2.2` — typed client, namespaces for `webhooks`, `enhanced`, `tx`, `ws`, etc. Built on `@solana/kit` (the v1.x line used `@solana/web3.js`).
  - Or plain `fetch` against the JSON-RPC endpoint — no dependencies, works in Cloudflare Workers / Deno / Bun without polyfills.
- For webhooks: a public HTTPS endpoint (Cloudflare Worker, Vercel function, ngrok tunnel for dev). Helius will not POST to `localhost`.

## Workflow

### 1. Get an API key
Sign in at https://dashboard.helius.dev, create a project, copy the API key. **Mainnet and devnet share the same key** — you switch by changing the endpoint hostname, not the key.

### 2. RPC endpoint URL format
```
Mainnet:  https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
Devnet:   https://devnet.helius-rpc.com/?api-key=YOUR_KEY

# Dedicated staked-connection endpoint (Pro+) for higher landing rate on sendTransaction:
Staked:   https://staked.helius-rpc.com/?api-key=YOUR_KEY
```

The endpoint accepts **every** standard Solana JSON-RPC method plus Helius extensions. Drop it into `@solana/web3.js` `new Connection(url)` or `@solana/kit` `createSolanaRpc(url)` unchanged.

### 3. DAS API — NFT / token queries
DAS unifies regular NFTs, compressed NFTs, and (with `showFungible: true`) SPL tokens behind one method family on the standard RPC endpoint. The most useful methods:

- `getAssetsByOwner` — every asset a wallet owns, paginated.
- `getAsset` — one asset by mint or cNFT ID.
- `getAssetsByGroup` — every asset in a collection (`groupKey: "collection"`).
- `searchAssets` — flexible filter (creator, royalty, jsonUri, etc.).

Pagination is **1-indexed page numbers**, max `limit: 1000`. Loop until `items.length < limit`. See `scripts/get-assets.ts`.

### 4. Webhook setup
Create a webhook with the REST API or `helius.webhooks.createWebhook(...)`. Key fields:

- `webhookURL` — your HTTPS endpoint (must return 200 within 1s).
- `webhookType` — `"enhanced"` (Helius parses to a typed event) or `"raw"` (full Solana tx). `enhancedDevnet` / `rawDevnet` for devnet. Enhanced webhooks **drop failed transactions**; raw webhooks include both.
- `accountAddresses` — up to 100,000 addresses to watch.
- `transactionTypes` — filter to specific parsed types (`SWAP`, `NFT_SALE`, `TRANSFER`, ..., or `ANY`). Only meaningful for `enhanced`.
- `authHeader` — a secret string. Helius echoes this value back in the `Authorization` header of every webhook POST. Your handler must compare it before processing.

### 5. Webhook handler
The handler must:
1. Verify the `Authorization` header equals the `authHeader` you registered.
2. Return `200` within **1 second** (Helius timeout). Do heavy work async — push onto a queue, then respond.
3. Be idempotent — Helius retries up to 3 times with a 1s gap on 5xx / timeout / non-403 4xx. Deduplicate on `signature`.

See `scripts/webhook-handler.ts` (Cloudflare Worker).

### 6. Enhanced transaction parser
For backfill / one-shot parsing (not push), POST signatures to:
```
POST https://api-mainnet.helius-rpc.com/v0/transactions
Body: { "transactions": ["sig1", "sig2", ...] }  // up to 100 per call
```
Same shape as the enhanced-webhook payload — `description`, `type`, `source`, `nativeTransfers`, `tokenTransfers`, `events`, `accountData`, etc. Useful for catching up after webhook downtime.

### 7. Priority fee estimation
`getPriorityFeeEstimate` returns a recommended **`microLamports`** value for `ComputeBudgetProgram.setComputeUnitPrice`. Call it with either:
- `accountKeys: [pubkey, ...]` — the writable accounts your tx touches, **or**
- `transaction: <base58-or-base64 serialized tx>` — Helius will extract accounts itself.

Pass `options.recommended: true` for a single-number answer, or `options.includeAllPriorityFeeLevels: true` to get the full `{ min, low, medium, high, veryHigh, unsafeMax }` histogram. See `scripts/priority-fee.ts`.

### 8. Free vs paid tiers — rate limits (as of 2026)
- **Developer (free)**: ~10 RPS, 1M credits/mo, no dedicated nodes.
- **Pro / Business / Professional**: higher RPS, staked-connection endpoint, larger webhook quotas, dedicated nodes available.

Each webhook **delivery costs 1 credit regardless of whether your endpoint succeeds**. DAS calls cost more credits than vanilla RPC. Check the live pricing page before relying on these numbers.

## Common pitfalls

- **Mixing devnet and mainnet** — same API key, different hostnames. Sending a mainnet transaction to `devnet.helius-rpc.com` will give you a confusing "blockhash not found" because the blockhash you fetched is from the other cluster. Always read your endpoint string back to yourself.
- **No backoff on 429** — the free tier rate-limits aggressively. Wrap every call in retry-with-exponential-backoff. The SDK does not do this for you.
- **Webhook returns non-200 or takes >1s** — Helius retries 3 times with a 1s gap, then drops the event forever. Acknowledge first (return 200), process after. In Cloudflare Workers, use `event.waitUntil()` to defer work past the response.
- **Forgetting DAS pagination** — `getAssetsByOwner` caps at `limit: 1000`. A whale wallet with 10k NFTs returns only the first 1k unless you loop `page: 1, 2, 3, ...`. Stop when `items.length < limit`.
- **Treating `priorityFeeEstimate` as lamports** — it is **microLamports** (1e-6 lamports). You pass it directly to `ComputeBudgetProgram.setComputeUnitPrice({ microLamports })`. Multiplying by 1e6 is a common and very expensive mistake.
- **Webhooks won't replay missed events** — there is no historical replay endpoint for past webhook deliveries. If your handler is down, those events are gone. On boot, backfill the gap with `getSignaturesForAddress` + the enhanced transactions parser API (step 6) over your watched accounts since the last processed slot.
- **Enhanced webhook drops failed tx** — if you need to see reverted swaps or failed mints, use `webhookType: "raw"` (or check `transactionError` field).
- **`authHeader` is plaintext, not HMAC** — anyone who can read your dashboard or webhook record can replay requests. Treat it like a bearer token: long, random, rotated. For high-value flows, also gate by source IP at your edge / WAF.

## References
- Helius docs hub: https://www.helius.dev/docs
- DAS API: https://www.helius.dev/docs/das-api
- Priority Fee API: https://www.helius.dev/docs/api-reference/priority-fee/getpriorityfeeestimate
- Webhooks: https://www.helius.dev/docs/api-reference/webhooks
- Enhanced Transactions: https://www.helius.dev/docs/api-reference/enhanced-transactions/gettransactions
- SDK GitHub: https://github.com/helius-labs/helius-sdk
- Dashboard: https://dashboard.helius.dev
- Discord (fastest support for quota / outage questions): https://discord.gg/helius

## Example scripts
See `scripts/get-assets.ts`, `scripts/webhook-handler.ts`, `scripts/priority-fee.ts`.

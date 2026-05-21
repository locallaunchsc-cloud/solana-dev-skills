/**
 * webhook-handler.ts — Cloudflare Worker that receives Helius enhanced webhooks.
 *
 * Deploy with wrangler:
 *   wrangler deploy scripts/webhook-handler.ts --name helius-webhook
 *
 * Required secrets (set with `wrangler secret put`):
 *   HELIUS_AUTH_HEADER   The same `authHeader` string you passed when creating
 *                        the webhook. Helius echoes it back in the
 *                        Authorization header on every POST.
 *
 * Register the webhook (one-time, from your laptop):
 *   curl -X POST "https://api.helius.xyz/v0/webhooks?api-key=$HELIUS_API_KEY" \
 *     -H 'Content-Type: application/json' \
 *     -d '{
 *       "webhookURL": "https://helius-webhook.<your-subdomain>.workers.dev",
 *       "webhookType": "enhanced",
 *       "transactionTypes": ["SWAP", "NFT_SALE", "TRANSFER"],
 *       "accountAddresses": ["<address-to-watch>"],
 *       "authHeader": "<long-random-secret-matching-HELIUS_AUTH_HEADER>"
 *     }'
 *
 * Hard rules Helius enforces:
 *   - Reply 200 within 1 second or the delivery is retried (3x, 1s gap).
 *   - Body is a JSON ARRAY of enhanced transactions, not a single object.
 *   - Idempotency is YOUR job: dedupe on `signature`.
 */

export interface Env {
  HELIUS_AUTH_HEADER: string;
  // Optional: bind a KV namespace called DEDUPE for signature-level idempotency.
  // DEDUPE?: KVNamespace;
}

// --- enhanced transaction payload (trimmed; full schema at
// https://www.helius.dev/docs/api-reference/enhanced-transactions/gettransactions) ---
interface NativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number; // lamports
}

interface TokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  fromTokenAccount: string;
  toTokenAccount: string;
  tokenAmount: number;
  mint: string;
}

interface EnhancedTx {
  signature: string;
  slot: number;
  timestamp: number;
  type: string; // "SWAP" | "NFT_SALE" | "TRANSFER" | "UNKNOWN" | ...
  source: string; // "JUPITER" | "MAGIC_EDEN" | "SYSTEM_PROGRAM" | ...
  description: string;
  fee: number;
  feePayer: string;
  nativeTransfers?: NativeTransfer[];
  tokenTransfers?: TokenTransfer[];
  accountData?: Array<{
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges?: unknown[];
  }>;
  events?: Record<string, unknown>;
  transactionError?: { error: string } | null;
}

// Timing-safe string compare. The Workers runtime does not expose Node's
// `crypto.timingSafeEqual`, so we roll a tiny constant-time check.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // 1. Verify the auth header.
    //    Helius docs: "Helius echoes this value in the Authorization header
    //    when sending data to your webhook endpoint."
    const expected = env.HELIUS_AUTH_HEADER;
    if (!expected) {
      // Misconfiguration on our side — DO NOT accept events without verifying.
      console.error("HELIUS_AUTH_HEADER secret not configured");
      return new Response("Server misconfigured", { status: 500 });
    }
    const got = request.headers.get("Authorization") ?? "";
    if (!safeEqual(got, expected)) {
      // 403 specifically — Helius docs note 403 is the only 4xx that is NOT retried,
      // which is what we want for auth failures (no point making them retry).
      console.warn("Rejected webhook with bad Authorization header");
      return new Response("Forbidden", { status: 403 });
    }

    // 2. Parse the body. Enhanced webhooks deliver an ARRAY of transactions.
    let txs: EnhancedTx[];
    try {
      txs = (await request.json()) as EnhancedTx[];
      if (!Array.isArray(txs)) throw new Error("Expected array");
    } catch (e) {
      // Bad payload — return 400 (not 5xx) so Helius does not retry.
      console.error("Failed to parse webhook body:", e);
      return new Response("Bad Request", { status: 400 });
    }

    // 3. Defer real work past the response. Helius gives us 1 second; anything
    //    network-bound (DB writes, follow-up RPC) must run after we 200.
    ctx.waitUntil(processBatch(txs /*, env*/));

    // 4. Acknowledge fast.
    return new Response("ok", { status: 200 });
  },
};

async function processBatch(txs: EnhancedTx[] /*, env: Env*/): Promise<void> {
  for (const tx of txs) {
    // Idempotency: skip if we've already seen this signature. With KV:
    //   if (await env.DEDUPE?.get(tx.signature)) continue;
    //   ctx.waitUntil(env.DEDUPE?.put(tx.signature, "1", { expirationTtl: 86_400 }));

    // Skip failed transactions if we somehow got them (enhanced webhooks
    // drop them upstream, but raw webhooks include them — be defensive).
    if (tx.transactionError) {
      console.log({ tag: "tx_failed", sig: tx.signature, err: tx.transactionError });
      continue;
    }

    // Structured log per transaction — one line each, easy to grep in tail.
    console.log(
      JSON.stringify({
        tag: "helius_tx",
        sig: tx.signature,
        slot: tx.slot,
        type: tx.type,
        source: tx.source,
        description: tx.description,
        fee_lamports: tx.fee,
        feePayer: tx.feePayer,
        native_count: tx.nativeTransfers?.length ?? 0,
        token_count: tx.tokenTransfers?.length ?? 0,
      }),
    );

    // Branch on parsed type. Add real handlers here.
    switch (tx.type) {
      case "SWAP":
        // tx.events.swap will hold tokenInputs/tokenOutputs/nativeInput/nativeOutput
        break;
      case "NFT_SALE":
        // tx.events.nft has buyer, seller, amount, nfts
        break;
      case "TRANSFER":
        // walk tx.nativeTransfers and tx.tokenTransfers
        break;
      default:
        // UNKNOWN or anything you didn't filter to — usually safe to ignore
        break;
    }
  }
}

/**
 * get-assets.ts — fetch every NFT and SPL token a wallet owns via Helius DAS API.
 *
 * Usage:
 *   HELIUS_API_KEY=xxx tsx scripts/get-assets.ts <WALLET_ADDRESS>
 *
 * What it shows:
 *   - JSON-RPC call to getAssetsByOwner against the standard RPC endpoint
 *     (DAS lives on the same URL as `getBalance` etc., just a different method).
 *   - Paginating through 1000-item pages until the wallet is exhausted.
 *   - Displaying NFTs (interface "V1_NFT" / "ProgrammableNFT" / "MplCoreAsset")
 *     and fungible tokens (showFungible: true) side-by-side.
 *   - No SDK — just fetch. Works in Node 20+, Bun, Deno, Cloudflare Workers.
 *
 * Tested against helius-rpc.com (mainnet) on May 18, 2026.
 */

const API_KEY = process.env.HELIUS_API_KEY;
if (!API_KEY) {
  console.error("Set HELIUS_API_KEY env var (get one at https://dashboard.helius.dev)");
  process.exit(1);
}

const OWNER = process.argv[2];
if (!OWNER) {
  console.error("Usage: tsx scripts/get-assets.ts <WALLET_ADDRESS>");
  process.exit(1);
}

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

// --- types (trimmed to the fields we actually read) ---------------------------

interface DasAsset {
  id: string;
  interface: string; // "V1_NFT" | "ProgrammableNFT" | "MplCoreAsset" | "FungibleToken" | "FungibleAsset" | ...
  content?: {
    metadata?: { name?: string; symbol?: string };
    links?: { image?: string };
    json_uri?: string;
  };
  ownership?: { owner: string };
  grouping?: Array<{ group_key: string; group_value: string }>;
  token_info?: {
    symbol?: string;
    decimals?: number;
    balance?: number;
    price_info?: { price_per_token?: number; total_price?: number; currency?: string };
  };
  compression?: { compressed: boolean };
}

interface DasResult {
  total: number;
  limit: number;
  page: number;
  items: DasAsset[];
  nativeBalance?: { lamports: number; price_per_sol?: number; total_price?: number };
}

// --- helper: one paginated request -------------------------------------------

async function fetchPage(ownerAddress: string, page: number, limit = 1000): Promise<DasResult> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `assets-${page}`,
      method: "getAssetsByOwner",
      params: {
        ownerAddress,
        page,
        limit,
        // showFungible:    include SPL tokens alongside NFTs (DAS-extended behavior)
        // showNativeBalance: also return wallet's SOL balance + USD value
        // showZeroBalance: skip empty token accounts (default false; flip to true if you want them)
        displayOptions: { showFungible: true, showNativeBalance: true },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Helius RPC HTTP ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { result?: DasResult; error?: { message: string } };
  if (body.error) throw new Error(`Helius RPC error: ${body.error.message}`);
  if (!body.result) throw new Error("Empty result from Helius");
  return body.result;
}

// --- main loop ----------------------------------------------------------------

async function main() {
  console.log(`Fetching all assets for ${OWNER}...\n`);

  const all: DasAsset[] = [];
  let page = 1;
  const LIMIT = 1000;
  let nativeSol = 0;

  // DAS pagination is 1-indexed. Stop when a page returns fewer than LIMIT items.
  // (There is no `hasMore` boolean — short page is the terminator.)
  while (true) {
    const result = await fetchPage(OWNER, page, LIMIT);
    all.push(...result.items);
    if (result.nativeBalance) nativeSol = result.nativeBalance.lamports / 1e9;

    console.log(`  page ${page}: +${result.items.length} (running total ${all.length})`);
    if (result.items.length < LIMIT) break;
    page += 1;

    // Friendly pause to avoid free-tier RPS limits when wallets are huge.
    await new Promise((r) => setTimeout(r, 100));
  }

  // --- split into NFTs vs fungibles ------------------------------------------
  const fungibleInterfaces = new Set(["FungibleToken", "FungibleAsset"]);
  const nfts = all.filter((a) => !fungibleInterfaces.has(a.interface));
  const fungibles = all.filter((a) => fungibleInterfaces.has(a.interface));

  console.log(`\n=== Wallet: ${OWNER} ===`);
  console.log(`SOL balance:   ${nativeSol.toFixed(4)} SOL`);
  console.log(`Total assets:  ${all.length}`);
  console.log(`  NFTs / cNFTs: ${nfts.length}`);
  console.log(`  Fungibles:    ${fungibles.length}\n`);

  if (nfts.length > 0) {
    console.log("--- NFTs (first 10) ---");
    for (const a of nfts.slice(0, 10)) {
      const name = a.content?.metadata?.name ?? "(unnamed)";
      const collection =
        a.grouping?.find((g) => g.group_key === "collection")?.group_value ?? "—";
      const compressed = a.compression?.compressed ? " [compressed]" : "";
      console.log(`  ${name}${compressed}`);
      console.log(`    id:         ${a.id}`);
      console.log(`    collection: ${collection}`);
    }
  }

  if (fungibles.length > 0) {
    console.log("\n--- Fungibles ---");
    for (const a of fungibles) {
      const sym = a.token_info?.symbol ?? a.content?.metadata?.symbol ?? "???";
      const dec = a.token_info?.decimals ?? 0;
      const bal = (a.token_info?.balance ?? 0) / 10 ** dec;
      const usd = a.token_info?.price_info?.total_price;
      const usdStr = usd ? ` ($${usd.toFixed(2)})` : "";
      console.log(`  ${sym.padEnd(10)} ${bal.toFixed(Math.min(dec, 6))}${usdStr}   mint=${a.id}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

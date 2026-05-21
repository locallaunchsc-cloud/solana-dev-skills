---
name: solana-metaplex-nft
description: Use this skill when the user wants to mint and manage NFT collections on Solana using Metaplex — Umi setup, Token Metadata vs MPL-Core (programmable assets), Arweave uploads, collection creation, minting, and verification.
---

# Metaplex NFT

## Overview

Metaplex is the dominant NFT standard on Solana, powering nearly every NFT minted on the network. As of 2026, two standards coexist: the classic **Token Metadata** program (NFTs built on SPL tokens — what powered DeGods, Mad Lads, etc.) and **MPL-Core**, the newer single-account standard that is cheaper to mint, simpler to compose with plugins, and the default recommendation for new collections. This skill defaults to **MPL-Core** and treats Token Metadata as legacy. All flows here use the **Umi** client framework (the supported successor to the deprecated JS SDK).

## When to use this skill

- "Mint an NFT on Solana"
- "Create an NFT collection"
- "Verify a collection on Solana"
- "Upload metadata to Arweave for an NFT"
- "What's the difference between MPL-Core and Token Metadata?"
- "How do I do programmable NFTs / pNFTs?"
- "Set royalties on a Solana NFT"

## Prerequisites

- **Node 20+** and TypeScript
- A funded **devnet** keypair (or mainnet for production)
- The image asset you want to mint, locally on disk

Install the pinned versions (verified May 2026):

```bash
npm install \
  @metaplex-foundation/umi@^1.5.1 \
  @metaplex-foundation/umi-bundle-defaults@^1.5.1 \
  @metaplex-foundation/mpl-core@^1.10.0 \
  @metaplex-foundation/mpl-token-metadata@^3.4.0 \
  @metaplex-foundation/umi-uploader-irys@^1.4.1

npm install -D tsx typescript @types/node
```

A devnet wallet keypair at `~/.config/solana/id.json` works out of the box. Fund it with `solana airdrop 2 --url devnet` before running anything that uploads to Irys.

## Workflow

### 1. Umi setup

Umi is a lightweight framework you compose with plugins. Order matters: install signers before uploaders so the uploader can sign funding transactions.

```typescript
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { mplCore } from '@metaplex-foundation/mpl-core'
import { keypairIdentity } from '@metaplex-foundation/umi'
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys'

const umi = createUmi('https://api.devnet.solana.com')
  .use(mplCore())
  .use(keypairIdentity(yourSigner))
  .use(irysUploader({ address: 'https://devnet.irys.xyz' }))
```

For **mainnet**, drop the `address` option — Irys auto-selects the mainnet bundler (`https://uploader.irys.xyz` / `https://node1.irys.xyz`) and pays in SOL.

### 2. Upload image + metadata JSON to Arweave via Irys

Irys (formerly Bundlr) is the standard for paying in SOL to write to permanent Arweave storage. Use the helpers:

```typescript
import { createGenericFile } from '@metaplex-foundation/umi'
import fs from 'node:fs'

const imageBytes = fs.readFileSync('./assets/nft.png')
const file = createGenericFile(imageBytes, 'nft.png', {
  tags: [{ name: 'Content-Type', value: 'image/png' }],
})
const [imageUri] = await umi.uploader.upload([file])

const metadataUri = await umi.uploader.uploadJson({
  name: 'My NFT',
  description: '...',
  image: imageUri,
  // ...
})
```

### 3. Off-chain metadata JSON spec

This is what marketplaces (Magic Eden, Tensor, etc.) parse to render your NFT:

```json
{
  "name": "Asset name (≤ 32 chars on-chain)",
  "symbol": "SHORT",
  "description": "Long-form description shown on marketplaces.",
  "image": "https://arweave.net/<image-tx-id>",
  "external_url": "https://yourproject.xyz",
  "attributes": [
    { "trait_type": "Background", "value": "Blue" },
    { "trait_type": "Rarity", "value": "Legendary" }
  ],
  "properties": {
    "files": [
      { "uri": "https://arweave.net/<image-tx-id>", "type": "image/png" }
    ],
    "category": "image",
    "creators": [
      { "address": "<wallet>", "share": 100 }
    ]
  }
}
```

The on-chain `name` and `uri` are stored directly; everything else lives in this JSON. On-chain `name` is capped at 32 bytes — keep the long version inside the JSON.

### 4. Create a Collection

**MPL-Core (recommended) — single account, ~0.0029 SOL rent:**

```typescript
import { createCollection, mplCore } from '@metaplex-foundation/mpl-core'
import { generateSigner } from '@metaplex-foundation/umi'

const collection = generateSigner(umi)
await createCollection(umi, {
  collection,
  name: 'My Collection',
  uri: collectionMetadataUri,
}).sendAndConfirm(umi)

console.log('Collection:', collection.publicKey)
```

**Token Metadata (legacy, Sized Collection) — for reference:**

```typescript
import { createNft } from '@metaplex-foundation/mpl-token-metadata'

const collectionMint = generateSigner(umi)
await createNft(umi, {
  mint: collectionMint,
  name: 'My Collection',
  uri: collectionMetadataUri,
  sellerFeeBasisPoints: percentAmount(0),
  isCollection: true,
}).sendAndConfirm(umi)
```

Recommendation: use MPL-Core unless you need compatibility with a marketplace or tool that only supports the classic standard (rare in 2026 — Tensor, Magic Eden, and Phantom all index Core).

### 5. Mint an NFT into the collection

```typescript
import { create, fetchCollection } from '@metaplex-foundation/mpl-core'

const collectionAccount = await fetchCollection(umi, collectionPubkey)
const asset = generateSigner(umi)

await create(umi, {
  asset,
  collection: collectionAccount,
  name: 'My NFT #1',
  uri: assetMetadataUri,
}).sendAndConfirm(umi)
```

Pass the **fetched collection account** (not just the pubkey) to `create()` — it carries the `updateAuthority` Core needs to auto-verify the asset.

### 6. Verify collection

- **MPL-Core**: automatic. If the same signer is both the collection's update authority and the `create()` payer/authority, the asset is verified at mint time. No second instruction.
- **Token Metadata (legacy)**: requires a separate `verifyCollectionV1` instruction after mint. Until you call it, the NFT shows as "Unverified" on Magic Eden / Tensor and is filtered out of the collection.

### 7. Update metadata

```typescript
import { update } from '@metaplex-foundation/mpl-core'

await update(umi, {
  asset: existingAsset,
  collection: collectionAccount, // if it's in a collection
  newName: 'Renamed NFT',
  newUri: newMetadataUri,
}).sendAndConfirm(umi)
```

Updates require the asset's update authority to sign. If the asset is in a collection, the collection's update authority controls updates by default.

### 8. Freeze / soulbind options (Core plugins)

MPL-Core's plugin system replaces the patchwork of Token Metadata extensions:

- `FreezeDelegate` — lock an asset so it can't be transferred (staking, escrow).
- `PermanentFreezeDelegate` — collection-level immutable freeze. Set once at collection creation.
- `Attributes` — on-chain key/value pairs (separate from off-chain JSON attributes).
- `Royalties` — on-chain royalty config with a `ruleSet` for allow/deny lists.
- `TransferDelegate` — gasless transfers, custodial flows.

Add a plugin at mint time:

```typescript
await create(umi, {
  asset,
  collection: collectionAccount,
  name: 'Soulbound Membership',
  uri: metadataUri,
  plugins: [
    {
      type: 'PermanentFreezeDelegate',
      frozen: true,
      authority: { type: 'None' }, // nobody can unfreeze => true soulbound
    },
  ],
}).sendAndConfirm(umi)
```

### 9. Royalty enforcement notes (2026)

This is the messy one. Solana NFT royalties have never been protocol-enforced — marketplaces decide whether to honor them. The state of play in 2026:

- **Magic Eden** honors royalties for MPL-Core assets with the `Royalties` plugin set to `Allowlist` mode.
- **Tensor** defaults to optional royalties; creator share is opt-in for the buyer.
- **Tensor / Sniper** ignore Token Metadata classic royalties unless explicitly listed.
- pNFTs (programmable NFTs from Token Metadata) were the previous enforcement path but added meaningful UX friction and have largely been superseded by Core's plugin system.

Practical guidance: **set realistic basis points (250–500 = 2.5–5%)**, use the Core `Royalties` plugin with an allowlist of marketplaces you've verified, and don't design your revenue model around guaranteed royalties.

## Common pitfalls

- **Mixing MPL-Core and Token Metadata accounts.** They are different programs with different account layouts. A Token Metadata collection mint can't be passed to `create()` from `mpl-core`, and vice versa. Check the program ID if `fetchCollection` returns `null` or "Account does not exist."
- **Forgetting to verify (Token Metadata path).** Mint succeeds, NFT exists, but it shows uncollected on Magic Eden until you run `verifyCollectionV1`. Core doesn't have this problem.
- **Image URL not pinned.** Uploading to `imgur` / your own server / a free CDN means the NFT breaks when the host disappears. Use Arweave (via Irys) or NFT.Storage / IPFS with paid pinning. Never link to a URL you don't control.
- **Devnet SOL insufficient for Irys.** Irys requires the wallet to fund the bundler with SOL before upload. Devnet airdrops are rate-limited — if `await umi.rpc.airdrop()` silently fails, the uploader will throw a cryptic "insufficient funds" error. Use `solana airdrop 2 --url devnet` from the CLI or a faucet like faucet.solana.com.
- **Royalty enforcement assumptions.** Marketplaces in 2026 do not universally enforce royalties. Don't promise creators a fixed cut — explain the marketplace-by-marketplace reality.
- **Wrong creator share percentages.** In the metadata JSON, `properties.creators[].share` values **must sum to exactly 100**. 99 or 101 will cause some indexers (Helius DAS, Tensor) to silently drop the creators array.
- **Mainnet uploads cost real SOL.** Irys mainnet uploads are paid in SOL based on Arweave network fees. A typical 500KB PNG + JSON is ~0.001–0.005 SOL but can spike with Arweave network congestion. Budget accordingly.
- **`generateSigner(umi)` for the asset, not just the collection.** A common copy-paste bug is reusing the collection signer when minting. Each asset is its own account and needs its own fresh signer.

## References

- Metaplex Core docs: https://developers.metaplex.com/core
- Core JavaScript SDK: https://developers.metaplex.com/core/sdk/javascript
- MPL-Core GitHub: https://github.com/metaplex-foundation/mpl-core
- Umi docs: https://developers.metaplex.com/umi
- Umi uploader (Irys): https://developers.metaplex.com/umi/storage
- Token Metadata (legacy reference): https://developers.metaplex.com/token-metadata
- Irys (Arweave bundler): https://docs.irys.xyz

## Example scripts

See `scripts/upload-asset.ts`, `scripts/create-collection.ts`, `scripts/mint-nft.ts` — run in that order:

```bash
npx tsx scripts/upload-asset.ts ./assets/collection.png "My Collection" "Genesis collection"
# → prints metadataUri, save it

npx tsx scripts/create-collection.ts <collectionMetadataUri>
# → prints collection pubkey, save it

# upload the per-NFT metadata first
npx tsx scripts/upload-asset.ts ./assets/nft1.png "My NFT #1" "First mint"

npx tsx scripts/mint-nft.ts <collectionPubkey> <nftMetadataUri>
# → prints asset pubkey + Explorer link
```

/**
 * mint-nft.ts
 *
 * Mints an MPL-Core AssetV1 into an existing CollectionV1. If the wallet
 * running this is the collection's updateAuthority, the asset is auto-verified
 * at mint time — no separate verifyCollection instruction needed (that was a
 * Token Metadata legacy footgun).
 *
 * Usage:
 *   npx tsx scripts/mint-nft.ts <collectionPubkey> <assetMetadataUri> [name]
 *
 * Example:
 *   npx tsx scripts/mint-nft.ts 9Wq...Hzu https://arweave.net/xyz... "My NFT #1"
 *
 * Output:
 *   Asset pubkey + Explorer link.
 *
 * Notes:
 *   - The signer running this must own the collection's updateAuthority key
 *     for auto-verification. If a different wallet holds updateAuthority,
 *     pass an `authority: <signer>` arg to create() and have that key sign.
 *   - To mint a soulbound (non-transferable) asset, see the `plugins` example
 *     near the bottom — uncomment + adjust.
 */

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import {
  generateSigner,
  keypairIdentity,
  publicKey,
} from '@metaplex-foundation/umi'
import { base58 } from '@metaplex-foundation/umi/serializers'
import {
  create,
  fetchCollection,
  mplCore,
} from '@metaplex-foundation/mpl-core'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RPC_URL = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com'
const KEYPAIR_PATH =
  process.env.SOLANA_KEYPAIR ?? path.join(os.homedir(), '.config', 'solana', 'id.json')
const CLUSTER = RPC_URL.includes('devnet') ? 'devnet' : 'mainnet-beta'

function loadKeypair(umi: ReturnType<typeof createUmi>) {
  const secret = JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8'))
  return umi.eddsa.createKeypairFromSecretKey(new Uint8Array(secret))
}

async function main() {
  const [collectionArg, metadataUri, name = 'My NFT'] = process.argv.slice(2)
  if (!collectionArg || !metadataUri) {
    console.error(
      'Usage: npx tsx scripts/mint-nft.ts <collectionPubkey> <assetMetadataUri> [name]',
    )
    process.exit(1)
  }

  const umi = createUmi(RPC_URL).use(mplCore())
  umi.use(keypairIdentity(loadKeypair(umi)))
  console.log('Minter:', umi.identity.publicKey)

  // 1. Fetch the collection account. Pass the FETCHED account (not the
  //    pubkey) to create() — it carries updateAuthority + plugin context
  //    Core needs to auto-verify and apply collection-level plugins.
  const collectionAddress = publicKey(collectionArg)
  const collection = await fetchCollection(umi, collectionAddress)
  console.log('Collection found:', collection.publicKey)
  console.log('  updateAuthority:', collection.updateAuthority)

  // 2. Fresh signer for the new asset account.
  const asset = generateSigner(umi)
  console.log('Asset pubkey (pre-tx):', asset.publicKey)

  // 3. Mint. With the same signer as the collection's updateAuthority,
  //    the asset is automatically verified as part of the collection.
  const tx = await create(umi, {
    asset,
    collection,
    name,
    uri: metadataUri,

    // Per-asset plugin examples (uncomment to use):
    //
    // Soulbound (non-transferable):
    // plugins: [
    //   { type: 'PermanentFreezeDelegate', frozen: true, authority: { type: 'None' } },
    // ],
    //
    // On-chain attributes (separate from off-chain JSON attributes):
    // plugins: [
    //   { type: 'Attributes', attributeList: [{ key: 'level', value: '1' }] },
    // ],
  }).sendAndConfirm(umi)

  const signature = base58.deserialize(tx.signature)[0]
  console.log('\nAsset minted.')
  console.log('  asset:     ', asset.publicKey)
  console.log('  signature: ', signature)
  console.log(
    `  explorer:   https://explorer.solana.com/address/${asset.publicKey}?cluster=${CLUSTER}`,
  )
  console.log(
    `  tx:         https://explorer.solana.com/tx/${signature}?cluster=${CLUSTER}`,
  )
  console.log(
    '\nVerify the asset shows under the collection: open the collection address',
    'in Explorer and check the "Assets" tab, or query Helius DAS by collection.',
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

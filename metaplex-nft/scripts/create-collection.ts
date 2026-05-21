/**
 * create-collection.ts
 *
 * Creates an MPL-Core CollectionV1 on devnet. A Core collection lives in a
 * single account (~0.0029 SOL rent) and acts as the parent for AssetV1 NFTs.
 *
 * Usage:
 *   npx tsx scripts/create-collection.ts <collectionMetadataUri> [name]
 *
 * Example:
 *   npx tsx scripts/create-collection.ts https://arweave.net/abc... "My Collection"
 *
 * Output:
 *   Collection pubkey + Explorer link.
 *
 * Notes:
 *   - The wallet running this script becomes the collection's `updateAuthority`.
 *     Whoever holds that key can update collection metadata AND auto-verify
 *     new assets minted into it. Keep this keypair safe.
 *   - For mainnet, set SOLANA_RPC=https://api.mainnet-beta.solana.com (or your
 *     preferred RPC like Helius/Triton — public mainnet RPC rate-limits hard).
 *   - To launch a soulbound collection, uncomment the `plugins` block below.
 */

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import {
  generateSigner,
  keypairIdentity,
  publicKey,
} from '@metaplex-foundation/umi'
import { base58 } from '@metaplex-foundation/umi/serializers'
import { createCollection, mplCore } from '@metaplex-foundation/mpl-core'
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
  const [metadataUri, name = 'My Collection'] = process.argv.slice(2)
  if (!metadataUri) {
    console.error(
      'Usage: npx tsx scripts/create-collection.ts <collectionMetadataUri> [name]',
    )
    process.exit(1)
  }

  // 1. Umi with mplCore + signer. mplCore() registers the program ID and codec.
  const umi = createUmi(RPC_URL).use(mplCore())
  umi.use(keypairIdentity(loadKeypair(umi)))

  console.log('Authority:', umi.identity.publicKey)
  console.log('Cluster: ', CLUSTER)

  // 2. Generate a fresh signer for the collection account. This pubkey
  //    becomes the on-chain address you reference everywhere else.
  const collection = generateSigner(umi)
  console.log('Collection pubkey (pre-tx):', collection.publicKey)

  // 3. Build + send the createCollection instruction.
  const tx = await createCollection(umi, {
    collection,
    name,
    uri: metadataUri,
    // updateAuthority defaults to umi.identity — passing it explicitly is
    // useful if you want a multisig or a separate authority key:
    // updateAuthority: publicKey('YourMultisigPubkey...'),

    // To make every asset minted into this collection soulbound, uncomment:
    // plugins: [
    //   {
    //     type: 'PermanentFreezeDelegate',
    //     frozen: true,
    //     authority: { type: 'None' },
    //   },
    // ],
  }).sendAndConfirm(umi)

  const signature = base58.deserialize(tx.signature)[0]
  console.log('\nCollection created.')
  console.log('  pubkey:    ', collection.publicKey)
  console.log('  signature: ', signature)
  console.log(
    `  explorer:   https://explorer.solana.com/address/${collection.publicKey}?cluster=${CLUSTER}`,
  )
  console.log(
    `  tx:         https://explorer.solana.com/tx/${signature}?cluster=${CLUSTER}`,
  )
  console.log('\nPass this pubkey to mint-nft.ts as the first argument.')

  // Silence unused-import lint while keeping publicKey() handy for the
  // commented-out updateAuthority example above.
  void publicKey
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

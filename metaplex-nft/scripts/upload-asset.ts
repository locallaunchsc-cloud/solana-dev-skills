/**
 * upload-asset.ts
 *
 * Uploads an image + metadata JSON to Arweave via Irys, returning a permanent
 * URI you'll plug into createCollection() or create() (MPL-Core).
 *
 * Usage:
 *   npx tsx scripts/upload-asset.ts <imagePath> <name> <description> [symbol]
 *
 * Example:
 *   npx tsx scripts/upload-asset.ts ./assets/nft.png "My NFT #1" "First mint" MYNFT
 *
 * Output:
 *   imageUri:    https://arweave.net/<tx-id>
 *   metadataUri: https://arweave.net/<tx-id>   <-- pass this to create-collection.ts or mint-nft.ts
 *
 * Notes:
 *   - Defaults to devnet Irys (https://devnet.irys.xyz). For mainnet, drop the
 *     `address` option from irysUploader() and fund the wallet with real SOL.
 *   - Uses ~/.config/solana/id.json by default. Override with SOLANA_KEYPAIR env var.
 *   - Devnet Irys is free up to a small per-tx threshold (~100KB). Larger files
 *     auto-fund from the wallet's devnet SOL — make sure you've airdropped first.
 */

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import {
  createGenericFile,
  keypairIdentity,
} from '@metaplex-foundation/umi'
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RPC_URL = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com'
const IRYS_ADDRESS = process.env.IRYS_ADDRESS ?? 'https://devnet.irys.xyz'
const KEYPAIR_PATH =
  process.env.SOLANA_KEYPAIR ?? path.join(os.homedir(), '.config', 'solana', 'id.json')

function loadKeypair(umi: ReturnType<typeof createUmi>) {
  const secret = JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8'))
  return umi.eddsa.createKeypairFromSecretKey(new Uint8Array(secret))
}

function contentTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase()
  return (
    {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.mp4': 'video/mp4',
    }[ext] ?? 'application/octet-stream'
  )
}

async function main() {
  const [imagePath, name, description, symbol] = process.argv.slice(2)
  if (!imagePath || !name || !description) {
    console.error(
      'Usage: npx tsx scripts/upload-asset.ts <imagePath> <name> <description> [symbol]',
    )
    process.exit(1)
  }
  if (!fs.existsSync(imagePath)) {
    console.error(`Image not found: ${imagePath}`)
    process.exit(1)
  }

  // 1. Build Umi: identity must be installed BEFORE irysUploader so the
  //    uploader can sign the funding transaction.
  const umi = createUmi(RPC_URL)
  const keypair = loadKeypair(umi)
  umi
    .use(keypairIdentity(keypair))
    .use(irysUploader({ address: IRYS_ADDRESS }))

  console.log('Uploader wallet:', umi.identity.publicKey)

  // 2. Wrap the image bytes as a Umi GenericFile, then upload.
  const imageBytes = fs.readFileSync(imagePath)
  const fileName = path.basename(imagePath)
  const file = createGenericFile(imageBytes, fileName, {
    tags: [{ name: 'Content-Type', value: contentTypeFor(imagePath) }],
  })

  console.log(`Uploading image (${imageBytes.length} bytes)...`)
  const [imageUri] = await umi.uploader.upload([file])
  console.log('imageUri:', imageUri)

  // 3. Construct the off-chain metadata JSON. This is what marketplaces parse.
  const metadata: Record<string, unknown> = {
    name,
    description,
    image: imageUri,
    external_url: '',
    attributes: [],
    properties: {
      files: [{ uri: imageUri, type: contentTypeFor(imagePath) }],
      category: 'image',
      creators: [{ address: umi.identity.publicKey, share: 100 }],
    },
  }
  if (symbol) metadata.symbol = symbol

  // 4. Upload the metadata JSON.
  console.log('Uploading metadata JSON...')
  const metadataUri = await umi.uploader.uploadJson(metadata)
  console.log('metadataUri:', metadataUri)

  console.log('\nDone. Pass metadataUri to create-collection.ts or mint-nft.ts:')
  console.log(`  ${metadataUri}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

/**
 * launch-token.ts
 *
 * End-to-end Token-2022 launch on Solana devnet:
 *   1. Load keypair from ~/.config/solana/devnet.json (or KEYPAIR_PATH env var)
 *   2. Create a Token-2022 mint with the on-mint MetadataPointer + TokenMetadata extensions
 *      (CreateAccount + InitializeMetadataPointer + InitializeMint + InitializeMetadata
 *       in one atomic transaction)
 *   3. Create the payer's associated token account (ATA)
 *   4. Mint the initial supply to that ATA
 *   5. Optionally revoke the mint authority (set REVOKE_MINT_AUTHORITY=true)
 *
 * Stack:
 *   @solana/web3.js          1.98.0
 *   @solana/spl-token        0.4.14
 *   @solana/spl-token-metadata 0.1.6
 *
 * Run:
 *   npx tsx scripts/launch-token.ts
 *
 * Why web3.js v1 (not the new @solana/kit / web3.js v2)?
 *   The SPL Token-Extensions helpers (createInitializeMetadataPointerInstruction,
 *   createInitializeMintInstruction) ship with v1-compatible APIs in @solana/spl-token 0.4.x.
 *   Migrate to kit once @solana-program/token-2022 has metadata-extension parity.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  AuthorityType,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import {
  createInitializeInstruction,
  pack,
  TokenMetadata,
  LENGTH_SIZE,
  TYPE_SIZE,
} from "@solana/spl-token-metadata";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RPC_URL = process.env.RPC_URL ?? clusterApiUrl("devnet");
const KEYPAIR_PATH =
  process.env.KEYPAIR_PATH ??
  path.join(os.homedir(), ".config", "solana", "devnet.json");

const TOKEN_NAME = process.env.TOKEN_NAME ?? "Skill Demo Token";
const TOKEN_SYMBOL = process.env.TOKEN_SYMBOL ?? "SKILL";
// In production: upload metadata JSON to Irys/Arweave first, paste the gateway URL here.
const TOKEN_URI =
  process.env.TOKEN_URI ??
  "https://gateway.irys.xyz/REPLACE_WITH_YOUR_METADATA_TX_ID";

const DECIMALS = Number(process.env.DECIMALS ?? 9);
const INITIAL_SUPPLY_WHOLE = BigInt(process.env.INITIAL_SUPPLY ?? "1000000000"); // 1B tokens
const REVOKE_MINT_AUTHORITY = process.env.REVOKE_MINT_AUTHORITY === "true";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadKeypair(filePath: string): Keypair {
  const raw = fs.readFileSync(filePath, "utf-8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

function explorer(addr: PublicKey | string, cluster = "devnet") {
  return `https://explorer.solana.com/address/${addr.toString()}?cluster=${cluster}`;
}

function txExplorer(sig: string, cluster = "devnet") {
  return `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Solana Token-2022 launch ===");
  console.log("RPC:        ", RPC_URL);
  console.log("Keypair:    ", KEYPAIR_PATH);

  const connection = new Connection(RPC_URL, "confirmed");
  const payer = loadKeypair(KEYPAIR_PATH);
  console.log("Payer:      ", payer.publicKey.toBase58());

  const payerBalance = await connection.getBalance(payer.publicKey);
  console.log("Balance:    ", payerBalance / 1e9, "SOL");
  if (payerBalance < 0.05 * 1e9) {
    throw new Error(
      "Payer needs at least 0.05 SOL for mint + ATA rent. Run `solana airdrop 2`."
    );
  }

  // -------------------------------------------------------------------------
  // 1. Generate mint keypair
  // -------------------------------------------------------------------------
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;
  console.log("\n[1] Mint:    ", mint.toBase58());

  // -------------------------------------------------------------------------
  // 2. Build the on-chain metadata blob & size the mint account accordingly
  // -------------------------------------------------------------------------
  const metadata: TokenMetadata = {
    mint,
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    uri: TOKEN_URI,
    additionalMetadata: [], // [["twitter", "@toly"], ...] if you want
  };

  const extensions = [ExtensionType.MetadataPointer];
  const mintLen = getMintLen(extensions);
  const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
  const lamports = await connection.getMinimumBalanceForRentExemption(
    mintLen + metadataLen
  );
  console.log("[2] Mint size (bytes):", mintLen, "+ metadata:", metadataLen);
  console.log("    Rent lamports:    ", lamports);

  // -------------------------------------------------------------------------
  // 3. Atomic transaction: create + init metadata pointer + init mint + init metadata
  //    Ordering is load-bearing:
  //      - CreateAccount (with TOKEN_2022_PROGRAM_ID as owner)
  //      - InitializeMetadataPointer  <-- must come BEFORE InitializeMint
  //      - InitializeMint
  //      - InitializeMetadata         <-- writes TLV data into the mint
  // -------------------------------------------------------------------------
  const createTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMetadataPointerInstruction(
      mint,
      payer.publicKey, // metadata pointer authority
      mint,            // metadata lives on the mint itself
      TOKEN_2022_PROGRAM_ID
    ),
    createInitializeMintInstruction(
      mint,
      DECIMALS,
      payer.publicKey, // mint authority
      payer.publicKey, // freeze authority (revoke later if desired)
      TOKEN_2022_PROGRAM_ID
    ),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mint,
      updateAuthority: payer.publicKey,
      mint: mint,
      mintAuthority: payer.publicKey,
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadata.uri,
    })
  );

  const createSig = await sendAndConfirmTransaction(
    connection,
    createTx,
    [payer, mintKeypair],
    { commitment: "confirmed" }
  );
  console.log("[3] Mint + metadata created:", txExplorer(createSig));

  // -------------------------------------------------------------------------
  // 4. Create ATA + mint initial supply
  // -------------------------------------------------------------------------
  const ata = getAssociatedTokenAddressSync(
    mint,
    payer.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  console.log("\n[4] ATA:     ", ata.toBase58());

  const supplyBaseUnits = INITIAL_SUPPLY_WHOLE * 10n ** BigInt(DECIMALS);
  console.log("    Minting:  ", INITIAL_SUPPLY_WHOLE.toString(), TOKEN_SYMBOL,
              "(", supplyBaseUnits.toString(), "base units)");

  const mintTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      ata,
      payer.publicKey,
      mint,
      TOKEN_2022_PROGRAM_ID
    ),
    createMintToInstruction(
      mint,
      ata,
      payer.publicKey,
      supplyBaseUnits,
      [],
      TOKEN_2022_PROGRAM_ID
    )
  );

  const mintSig = await sendAndConfirmTransaction(
    connection,
    mintTx,
    [payer],
    { commitment: "confirmed" }
  );
  console.log("    Tx:        ", txExplorer(mintSig));

  // -------------------------------------------------------------------------
  // 5. Optional: revoke mint authority (one-way!)
  // -------------------------------------------------------------------------
  if (REVOKE_MINT_AUTHORITY) {
    console.log("\n[5] Revoking mint authority (IRREVERSIBLE)...");
    const revokeTx = new Transaction().add(
      createSetAuthorityInstruction(
        mint,
        payer.publicKey,
        AuthorityType.MintTokens,
        null, // null = revoke forever
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );
    const revokeSig = await sendAndConfirmTransaction(
      connection,
      revokeTx,
      [payer],
      { commitment: "confirmed" }
    );
    console.log("    Revoked:   ", txExplorer(revokeSig));
  } else {
    console.log(
      "\n[5] Skipping mint-authority revoke (set REVOKE_MINT_AUTHORITY=true to enable)."
    );
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log("\n=== DONE ===");
  console.log("Mint:        ", mint.toBase58());
  console.log("Explorer:    ", explorer(mint));
  console.log("ATA:         ", ata.toBase58());
  console.log("Supply:      ", INITIAL_SUPPLY_WHOLE.toString(), TOKEN_SYMBOL);
  console.log("Decimals:    ", DECIMALS);
  console.log("Metadata URI:", TOKEN_URI);
  console.log("Mint auth:   ", REVOKE_MINT_AUTHORITY ? "REVOKED" : payer.publicKey.toBase58());
  console.log("Freeze auth: ", payer.publicKey.toBase58(), "(revoke separately if desired)");
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});

/**
 * Pyth pull-oracle: fetch the latest SOL/USD update from Hermes, post it
 * on-chain via the Pyth Solana Receiver, and invoke our Anchor consumer
 * program — all in the same versioned transaction.
 *
 * package.json:
 *   {
 *     "type": "module",
 *     "dependencies": {
 *       "@pythnetwork/pyth-solana-receiver": "^0.15.0",
 *       "@pythnetwork/hermes-client":        "^2.0.0",
 *       "@coral-xyz/anchor":                 "^0.31.1",
 *       "@solana/web3.js":                   "^1.98.4"
 *     },
 *     "devDependencies": {
 *       "tsx":        "^4.19.0",
 *       "typescript": "^5.6.0"
 *     }
 *   }
 *
 * Run:
 *   export ANCHOR_PROVIDER_URL='https://api.devnet.solana.com'
 *   export ANCHOR_WALLET="$HOME/.config/solana/id.json"
 *   npx tsx update-and-consume.ts
 */

import { AnchorProvider, Program, Wallet, AnchorError, BN } from "@coral-xyz/anchor";
import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import * as fs from "node:fs";

// ----- Config -----------------------------------------------------------------

// SOL/USD on Pyth. Same ID on every chain Pyth supports.
// Browse all feeds at https://www.pyth.network/developers/price-feed-ids
const SOL_USD_FEED_ID =
  "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

// Your deployed Anchor consumer program (from anchor-program.rs).
const CONSUMER_PROGRAM_ID = new PublicKey(
  "PythConsumer1111111111111111111111111111111",
);

const HERMES_URL = "https://hermes.pyth.network/";

// Amount of SOL (in lamports) we want to value in USD.
const AMOUNT_LAMPORTS = new BN(1_000_000_000); // 1 SOL

// ----- Wallet + connection ----------------------------------------------------

function loadWallet(): Wallet {
  const path = process.env.ANCHOR_WALLET;
  if (!path) {
    throw new Error("ANCHOR_WALLET env var must point to a Solana keypair JSON");
  }
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8")));
  return new Wallet(Keypair.fromSecretKey(secret));
}

const rpcUrl = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
const connection = new Connection(rpcUrl, "confirmed");
const wallet = loadWallet();
const provider = new AnchorProvider(connection, wallet, {
  commitment: "confirmed",
  skipPreflight: true, // pull-update txs are large; skip preflight per Pyth docs
});

// ----- Main -------------------------------------------------------------------

async function main() {
  console.log("RPC:    ", rpcUrl);
  console.log("Signer: ", wallet.publicKey.toBase58());

  // 1. Fetch the latest signed price update from Hermes.
  const hermes = new HermesClient(HERMES_URL, {});
  const updates = await hermes.getLatestPriceUpdates([SOL_USD_FEED_ID], {
    encoding: "base64",
  });
  const priceUpdateData: string[] = updates.binary.data;

  // Optional: peek at the parsed price so logs are useful before we hit chain.
  const parsed = updates.parsed?.[0];
  if (parsed) {
    const p = Number(parsed.price.price) * 10 ** parsed.price.expo;
    const c = Number(parsed.price.conf) * 10 ** parsed.price.expo;
    console.log(
      `Hermes says SOL/USD = $${p.toFixed(4)} ± $${c.toFixed(4)} ` +
        `(publish_time ${new Date(parsed.price.publish_time * 1000).toISOString()})`,
    );
  }

  // 2. Build a transaction that:
  //      a) posts the price update (creates an ephemeral PriceUpdateV2 acct),
  //      b) invokes our consumer program with that account,
  //      c) closes the price update account to reclaim rent.
  const receiver = new PythSolanaReceiver({ connection, wallet });
  const txBuilder = receiver.newTransactionBuilder({
    closeUpdateAccounts: true,
  });

  await txBuilder.addPostPriceUpdates(priceUpdateData);

  await txBuilder.addPriceConsumerInstructions(
    async (
      getPriceUpdateAccount: (feedId: string) => PublicKey,
    ): Promise<{ instruction: TransactionInstruction; signers: Keypair[] }[]> => {
      const priceUpdate = getPriceUpdateAccount(SOL_USD_FEED_ID);
      console.log("Price update account:", priceUpdate.toBase58());

      // Hand-built instruction so this script doesn't depend on a generated IDL.
      // Anchor discriminator for `value_of_sol_in_usd` is sha256("global:value_of_sol_in_usd")[..8].
      const discriminator = Buffer.from([
        // pre-computed: sha256("global:value_of_sol_in_usd")[0..8]
        // If you rename the instruction, regenerate via:
        //   node -e 'console.log([...require("crypto").createHash("sha256").update("global:value_of_sol_in_usd").digest().subarray(0,8)])'
        0xa1, 0x6c, 0xfa, 0xee, 0x9f, 0x6d, 0x4b, 0xc4,
      ]);
      const amountBuf = Buffer.alloc(8);
      amountBuf.writeBigUInt64LE(BigInt(AMOUNT_LAMPORTS.toString()));
      const data = Buffer.concat([discriminator, amountBuf]);

      const ix = new TransactionInstruction({
        programId: CONSUMER_PROGRAM_ID,
        keys: [
          { pubkey: priceUpdate, isSigner: false, isWritable: false },
          { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
        ],
        data,
      });

      return [{ instruction: ix, signers: [] }];
    },
  );

  // 3. Send. Pull-update txs are too large for a single legacy tx, so the
  //    builder returns versioned txs (sometimes >1) with an ALT pre-attached.
  const versionedTxs = await txBuilder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: 50_000,
  });

  console.log(`Sending ${versionedTxs.length} tx(s)...`);
  const sigs = await receiver.provider.sendAll(versionedTxs, {
    skipPreflight: true,
  });

  for (const sig of sigs) {
    console.log("Confirmed:", sig);
    console.log(`  https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  }
}

main().catch((err) => {
  if (err instanceof AnchorError) {
    console.error("Anchor error:", err.error.errorCode.code, err.error.errorMessage);
  } else {
    console.error(err);
  }
  process.exit(1);
});

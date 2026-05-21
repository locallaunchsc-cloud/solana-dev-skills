/**
 * create-multisig.ts
 *
 * Creates a 2-of-3 Squads V4 multisig on devnet and funds vault 0 with 0.1 SOL.
 *
 * Usage:
 *   npx ts-node scripts/create-multisig.ts
 *
 * After it runs, copy the printed MULTISIG_PDA into propose-and-execute.ts
 * (or export it as the SQUADS_MULTISIG_PDA env var).
 *
 * Requires a funded local Solana keypair at the default location
 * (`solana-keygen new` then `solana airdrop 2 --url devnet`).
 *
 * For the demo to be end-to-end runnable on a single machine, members 2 and 3
 * are generated fresh and their secret keys are written to ./.demo-keys/.
 * In production you would never do this — each member's key lives on their
 * own hardware wallet / machine and they call `proposalApprove` independently.
 */

import * as multisig from "@sqds/multisig";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import os from "os";

const { Permission, Permissions } = multisig.types;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const KEYPAIR_PATH =
  process.env.KEYPAIR_PATH ??
  path.join(os.homedir(), ".config", "solana", "id.json");

// Where the demo persists member keypairs so propose-and-execute.ts can load
// them. In production this directory should not exist — each signing key
// lives only on its owner's machine / hardware wallet.
const DEMO_KEYS_DIR = path.join(process.cwd(), ".demo-keys");

// TODO: replace these with the real pubkeys of the people / hardware wallets
//       that will hold signing keys for this multisig. Leave as `null` to
//       have the demo generate fresh keypairs locally.
const HARDCODED_MEMBER_PUBKEYS: (PublicKey | null)[] = [
  // member 1: always the creator (loaded from KEYPAIR_PATH below)
  null,
  // TODO: PublicKey of member 2 (e.g. a co-founder's hardware wallet)
  null,
  // TODO: PublicKey of member 3 (e.g. a security partner's key)
  null,
];

const THRESHOLD = 2; // 2-of-3

// ---------------------------------------------------------------------------

function loadKeypair(p: string): Keypair {
  const secret = JSON.parse(readFileSync(p, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function saveKeypair(kp: Keypair, p: string) {
  writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");

  // The "creator" is whoever pays for the create transaction. They also become
  // member 1 of the multisig (with full permissions) in this script.
  const creator = loadKeypair(KEYPAIR_PATH);
  console.log("creator (member 1):      ", creator.publicKey.toBase58());

  const creatorBalance = await connection.getBalance(creator.publicKey);
  if (creatorBalance < 0.2 * LAMPORTS_PER_SOL) {
    console.error(
      `creator has only ${creatorBalance / LAMPORTS_PER_SOL} SOL. ` +
        `Run: solana airdrop 2 ${creator.publicKey.toBase58()} --url devnet`
    );
    process.exit(1);
  }

  // Resolve member 2 and 3. If unset, generate fresh keypairs and persist them
  // so propose-and-execute.ts can sign approvals as those members.
  if (!existsSync(DEMO_KEYS_DIR)) mkdirSync(DEMO_KEYS_DIR);

  let member2Pubkey: PublicKey;
  if (HARDCODED_MEMBER_PUBKEYS[1]) {
    member2Pubkey = HARDCODED_MEMBER_PUBKEYS[1];
  } else {
    const kp = Keypair.generate();
    saveKeypair(kp, path.join(DEMO_KEYS_DIR, "member2.json"));
    member2Pubkey = kp.publicKey;
  }

  let member3Pubkey: PublicKey;
  if (HARDCODED_MEMBER_PUBKEYS[2]) {
    member3Pubkey = HARDCODED_MEMBER_PUBKEYS[2];
  } else {
    const kp = Keypair.generate();
    saveKeypair(kp, path.join(DEMO_KEYS_DIR, "member3.json"));
    member3Pubkey = kp.publicKey;
  }
  console.log("member 2:                ", member2Pubkey.toBase58());
  console.log("member 3:                ", member3Pubkey.toBase58());

  // The createKey is a one-time Keypair whose pubkey seeds the multisigPda.
  // It signs the create transaction and is then thrown away — it is NOT a
  // member, and cannot vote, approve, or execute. Generate fresh each time;
  // reusing it would collide with an existing multisigPda.
  const createKey = Keypair.generate();

  // Derive the multisig account PDA from the createKey pubkey.
  // This is the on-chain account that stores members, threshold, and the
  // monotonic transaction index. It is NOT where funds live.
  const [multisigPda] = multisig.getMultisigPda({
    createKey: createKey.publicKey,
  });
  console.log("multisig PDA:            ", multisigPda.toBase58());

  // Derive vault 0 — the actual signer that holds funds and signs CPIs.
  // Every multisig automatically has vaults at indexes 0, 1, 2, ...
  // Vault 0 is the conventional default ("the treasury").
  const [vaultPda] = multisig.getVaultPda({
    multisigPda,
    index: 0,
  });
  console.log("vault PDA (index 0):     ", vaultPda.toBase58());

  // The Squads program has a global ProgramConfig account that stores the
  // protocol-level treasury that collects the create-fee. We need to read it
  // and pass `treasury` into multisigCreateV2.
  const programConfigPda = multisig.getProgramConfigPda({})[0];
  const programConfig =
    await multisig.accounts.ProgramConfig.fromAccountAddress(
      connection,
      programConfigPda
    );
  const configTreasury = programConfig.treasury;
  console.log("program config treasury: ", configTreasury.toBase58());

  // Create the multisig.
  //
  //   threshold: 2          -> 2 votes required to pass a proposal
  //   configAuthority: null -> autonomous multisig (member changes require a vote)
  //   timeLock: 0           -> no delay between approval and execution
  //                            (for program upgrade authority multisigs in
  //                            production, set this to >= 86400 (24h))
  //   rentCollector: null   -> rent from closed tx accounts is not recovered
  console.log("creating multisig...");
  const createSig = await multisig.rpc.multisigCreateV2({
    connection,
    createKey,
    creator,
    multisigPda,
    configAuthority: null,
    timeLock: 0,
    members: [
      {
        key: creator.publicKey,
        permissions: Permissions.all(),
      },
      {
        key: member2Pubkey,
        permissions: Permissions.fromPermissions([
          Permission.Initiate,
          Permission.Vote,
          Permission.Execute,
        ]),
      },
      {
        key: member3Pubkey,
        permissions: Permissions.fromPermissions([
          Permission.Initiate,
          Permission.Vote,
          Permission.Execute,
        ]),
      },
    ],
    threshold: THRESHOLD,
    rentCollector: null,
    treasury: configTreasury,
    sendOptions: { skipPreflight: true },
  });

  await connection.confirmTransaction(
    {
      signature: createSig,
      ...(await connection.getLatestBlockhash("confirmed")),
    },
    "confirmed"
  );
  console.log("multisig created. signature:", createSig);

  // Fund vault 0 with 0.1 SOL so the next script has something to spend.
  // The vault is a normal PDA — just transfer to it.
  console.log("funding vault 0 with 0.1 SOL...");
  const fundIx = SystemProgram.transfer({
    fromPubkey: creator.publicKey,
    toPubkey: vaultPda,
    lamports: 0.1 * LAMPORTS_PER_SOL,
  });
  const blockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const fundTx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: creator.publicKey,
      recentBlockhash: blockhash,
      instructions: [fundIx],
    }).compileToV0Message()
  );
  fundTx.sign([creator]);
  const fundSig = await connection.sendTransaction(fundTx);
  await connection.confirmTransaction(
    { signature: fundSig, ...(await connection.getLatestBlockhash("confirmed")) },
    "confirmed"
  );
  console.log("vault funded. signature:", fundSig);

  const vaultBalance = await connection.getBalance(vaultPda);
  console.log(`vault balance: ${vaultBalance / LAMPORTS_PER_SOL} SOL`);

  // Persist the multisig PDA so propose-and-execute.ts can find it without
  // needing to copy-paste.
  writeFileSync(
    path.join(DEMO_KEYS_DIR, "multisig.json"),
    JSON.stringify({ multisigPda: multisigPda.toBase58() }, null, 2)
  );

  console.log("\n========================================");
  console.log("DONE. Save these values for the next step:");
  console.log("========================================");
  console.log(`MULTISIG_PDA = ${multisigPda.toBase58()}`);
  console.log(`VAULT_PDA    = ${vaultPda.toBase58()}`);
  console.log(`THRESHOLD    = ${THRESHOLD}`);
  console.log("========================================");
  console.log("\nDemo keypairs written to ./.demo-keys/ — DO NOT commit.");
  console.log("Run the proposal flow with:");
  console.log("  npx ts-node scripts/propose-and-execute.ts");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

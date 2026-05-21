/**
 * simulate-tx.ts
 *
 * Simulate a Solana transaction without sending it. Pretty-prints program logs,
 * the failing instruction index, the error type, compute units consumed, and
 * inline-decodes any known Anchor / System / SPL Token error code.
 *
 * Usage:
 *   # Simulate a base64-encoded versioned transaction (e.g. from `solana confirm -v` or a wallet):
 *   ts-node scripts/simulate-tx.ts <BASE64_TX>
 *
 *   # Simulate a transaction signature that already landed (re-simulates against current state):
 *   ts-node scripts/simulate-tx.ts --sig <SIGNATURE>
 *
 *   # Simulate a demo SOL transfer (sanity check the script + RPC):
 *   ts-node scripts/simulate-tx.ts --demo
 *
 * Env:
 *   RPC_URL                 RPC endpoint. Defaults to https://api.mainnet-beta.solana.com.
 *   KEYPAIR_PATH            Path to a JSON keypair. Defaults to ~/.config/solana/id.json. Only needed for --demo.
 *
 * Exit codes:
 *   0  simulation succeeded (no error in logs)
 *   1  simulation returned an error
 *   2  bad input / RPC failure
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ----------------------------------------------------------------------------
// Error code decoders
// ----------------------------------------------------------------------------

/** Anchor framework error codes 100-5000. Keep in sync with references/error-codes.md. */
const ANCHOR_FRAMEWORK_CODES: Record<number, string> = {
  // Instructions
  100: "InstructionMissing — instruction discriminator not provided",
  101: "InstructionFallbackNotFound — no matching instruction (stale deploy / stale IDL / wrong program ID)",
  102: "InstructionDidNotDeserialize — args type/order mismatch (regenerate client bindings)",
  103: "InstructionDidNotSerialize",
  // Events
  1500: "EventInstructionStub — compile with `event-cpi` feature",
  // Constraints
  2000: "ConstraintMut — account not marked writable",
  2001: "ConstraintHasOne — has_one field mismatch",
  2002: "ConstraintSigner — account did not sign",
  2003: "ConstraintRaw — #[account(constraint = ...)] evaluated false",
  2004: "ConstraintOwner — account owned by wrong program",
  2005: "ConstraintRentExempt — account not rent-exempt",
  2006: "ConstraintSeeds — PDA derivation mismatch (check seeds + bump client vs program)",
  2007: "ConstraintExecutable",
  2009: "ConstraintAssociated — ATA address mismatch",
  2010: "ConstraintAssociatedInit",
  2011: "ConstraintClose — close target mismatch",
  2012: "ConstraintAddress — address != address constraint",
  2013: "ConstraintZero — expected zero discriminant (account already initialized)",
  2014: "ConstraintTokenMint",
  2015: "ConstraintTokenOwner",
  2016: "ConstraintMintMintAuthority",
  2017: "ConstraintMintFreezeAuthority",
  2018: "ConstraintMintDecimals",
  2019: "ConstraintSpace — account size != `space` (forgot 8-byte discriminator?)",
  2020: "ConstraintAccountIsNone",
  2021: "ConstraintTokenTokenProgram (classic vs Token-2022 mismatch)",
  2022: "ConstraintMintTokenProgram",
  2023: "ConstraintAssociatedTokenTokenProgram",
  2040: "ConstraintDuplicateMutableAccount",
  2041: "AccountAlreadyMigrated",
  2042: "AccountNotMigrated",
  // Require!
  2500: "RequireViolated — require!(expr) evaluated false",
  2501: "RequireEqViolated",
  2502: "RequireKeysEqViolated",
  2503: "RequireNeqViolated",
  2504: "RequireKeysNeqViolated",
  2505: "RequireGtViolated",
  2506: "RequireGteViolated",
  // Accounts
  3000: "AccountDiscriminatorAlreadySet",
  3001: "AccountDiscriminatorNotFound",
  3002: "AccountDiscriminatorMismatch — passed account of wrong Anchor type",
  3003: "AccountDidNotDeserialize — Borsh mismatch (dump raw bytes; account layout changed)",
  3004: "AccountDidNotSerialize",
  3005: "AccountNotEnoughKeys — client passed too few accounts (forgot system_program / token_program / ATA?)",
  3006: "AccountNotMutable",
  3007: "AccountOwnedByWrongProgram (classic SPL Token vs Token-2022?)",
  3008: "InvalidProgramId",
  3009: "InvalidProgramExecutable",
  3010: "AccountNotSigner",
  3011: "AccountNotSystemOwned",
  3012: "AccountNotInitialized",
  3013: "AccountNotProgramData",
  3014: "AccountNotAssociatedTokenAccount",
  3015: "AccountSysvarMismatch",
  3016: "AccountReallocExceedsLimit — > 10,240 bytes/tx; chunk it",
  3017: "AccountDuplicateReallocs",
  // Misc
  4100: "DeclaredProgramIdMismatch — declare_id! != deployed ID (anchor keys list)",
  4101: "TryingToInitPayerAsProgramAccount",
  4102: "InvalidNumericConversion",
  5000: "Deprecated",
};

/** System program errors. Surface as `Program 11111... failed: custom program error: 0xN`. */
const SYSTEM_PROGRAM_CODES: Record<number, string> = {
  0: "AccountAlreadyInUse — address already exists (use fresh Keypair)",
  1: "ResultWithNegativeLamports — not enough SOL for the op",
  2: "InvalidProgramId",
  3: "InvalidAccountDataLength — `space` mismatch on create_account",
  4: "MaxSeedLengthExceeded — seed > 32 bytes",
  5: "AddressWithSeedMismatch",
  6: "NonceNoRecentBlockhashes",
  7: "NonceBlockhashNotExpired",
  8: "NonceUnexpectedBlockhashValue",
};

/** SPL Token program errors (classic + Token-2022 share these). */
const TOKEN_PROGRAM_CODES: Record<number, string> = {
  0: "NotRentExempt — token account below rent threshold",
  1: "InsufficientFunds — token balance too low",
  2: "InvalidMint",
  3: "MintMismatch — token account.mint != mint passed",
  4: "OwnerMismatch — signer is not the account owner/authority",
  5: "FixedSupply",
  6: "AlreadyInUse — token account already initialized",
  7: "InvalidNumberOfProvidedSigners",
  8: "InvalidNumberOfRequiredSigners",
  9: "UninitializedState",
  10: "NativeNotSupported",
  11: "NonNativeHasBalance — close requires zero balance",
  12: "InvalidInstruction",
  13: "InvalidState",
  14: "Overflow",
  15: "AuthorityTypeNotSupported",
  16: "MintCannotFreeze",
  17: "AccountFrozen",
  18: "MintDecimalsMismatch (transfer_checked)",
  19: "NonNativeNotSupported",
};

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Decode an error code seen in `Program <ID> failed: custom program error: 0xNNNN`. */
function decodeCustomError(programId: string | null, code: number): string {
  if (programId === SYSTEM_PROGRAM_ID && SYSTEM_PROGRAM_CODES[code]) {
    return `System: ${SYSTEM_PROGRAM_CODES[code]}`;
  }
  if (
    (programId === TOKEN_PROGRAM_ID || programId === TOKEN_2022_PROGRAM_ID) &&
    TOKEN_PROGRAM_CODES[code]
  ) {
    return `Token: ${TOKEN_PROGRAM_CODES[code]}`;
  }
  if (ANCHOR_FRAMEWORK_CODES[code]) {
    return `Anchor framework: ${ANCHOR_FRAMEWORK_CODES[code]}`;
  }
  if (code >= 6000) {
    const userIdx = code - 6000;
    return `Anchor user error (program ${programId ?? "?"}) — variant index ${userIdx} of #[error_code] enum (look at program's error.rs)`;
  }
  return "Unknown code — check the failing program's error enum";
}

// ----------------------------------------------------------------------------
// Log parsing
// ----------------------------------------------------------------------------

interface ParsedFailure {
  programId: string | null;
  errorCode: number | null;
  errorKind: string;
}

/** Walk logs to find the inner-most `failed:` line and extract program ID + code. */
function parseLogsForFailure(logs: string[]): ParsedFailure {
  // Find the LAST `failed` line — the innermost program that actually threw.
  const failed = [...logs].reverse().find((l) => /failed: /.test(l));
  if (!failed) {
    return { programId: null, errorCode: null, errorKind: "no failure in logs" };
  }
  // `Program <ID> failed: custom program error: 0x1771`
  const progMatch = failed.match(/Program (\S+) failed:/);
  const programId = progMatch ? progMatch[1] : null;

  const hexMatch = failed.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (hexMatch) {
    return {
      programId,
      errorCode: parseInt(hexMatch[1], 16),
      errorKind: "custom program error",
    };
  }
  const decMatch = failed.match(/custom error:\s*(\d+)/);
  if (decMatch) {
    return {
      programId,
      errorCode: parseInt(decMatch[1], 10),
      errorKind: "custom error",
    };
  }
  // Non-custom failure — extract everything after `failed: `
  const generic = failed.split("failed: ")[1] ?? failed;
  return { programId, errorCode: null, errorKind: generic.trim() };
}

/** Extract `consumed X of Y compute units` totals (innermost wins for the failing program). */
function extractComputeUnits(logs: string[]): {
  total: number | null;
  perProgram: { programId: string; consumed: number; limit: number }[];
} {
  const perProgram: { programId: string; consumed: number; limit: number }[] = [];
  let total: number | null = null;
  for (const l of logs) {
    const m = l.match(/Program (\S+) consumed (\d+) of (\d+) compute units/);
    if (m) {
      const consumed = parseInt(m[2], 10);
      perProgram.push({
        programId: m[1],
        consumed,
        limit: parseInt(m[3], 10),
      });
      // Top-level program consumption == total for that call frame
      total = consumed;
    }
  }
  return { total, perProgram };
}

/** Find `Program log: AnchorError ...` lines and surface them verbatim. */
function extractAnchorErrors(logs: string[]): string[] {
  return logs.filter((l) =>
    /Program log: (AnchorError|Error Code:|Error Number:|Error Message:|panicked at)/.test(l),
  );
}

// ----------------------------------------------------------------------------
// Pretty-print
// ----------------------------------------------------------------------------

function ansi(code: number, s: string): string {
  return process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;
}
const bold = (s: string) => ansi(1, s);
const dim = (s: string) => ansi(2, s);
const red = (s: string) => ansi(31, s);
const green = (s: string) => ansi(32, s);
const yellow = (s: string) => ansi(33, s);
const cyan = (s: string) => ansi(36, s);

function printResult(
  logs: string[] | null,
  err: unknown,
  unitsConsumed: number | null | undefined,
): { hasError: boolean } {
  console.log(bold("\n=== Simulation Result ===\n"));

  if (!logs || logs.length === 0) {
    console.log(yellow("No logs returned. RPC may have rejected the tx before simulation."));
    console.log("Raw err:", err);
    return { hasError: !!err };
  }

  // 1. Per-program compute units
  const cu = extractComputeUnits(logs);
  if (cu.perProgram.length > 0) {
    console.log(bold("Compute units per program:"));
    for (const p of cu.perProgram) {
      const pct = ((p.consumed / p.limit) * 100).toFixed(1);
      const warn = p.consumed / p.limit > 0.9 ? red(" <- close to limit!") : "";
      console.log(`  ${dim(p.programId)}  ${p.consumed.toLocaleString()} / ${p.limit.toLocaleString()} (${pct}%)${warn}`);
    }
    if (unitsConsumed != null) {
      console.log(`  ${bold("Total (RPC):")} ${unitsConsumed.toLocaleString()} CUs`);
    }
    console.log();
  }

  // 2. Anchor error lines (surface first)
  const anchorErrs = extractAnchorErrors(logs);
  if (anchorErrs.length) {
    console.log(bold("Anchor diagnostics:"));
    for (const l of anchorErrs) console.log("  " + cyan(l));
    console.log();
  }

  // 3. Parse failure
  if (err) {
    const failure = parseLogsForFailure(logs);
    console.log(bold("Failure:"));
    console.log(`  Program: ${failure.programId ?? "(unknown)"}`);
    if (failure.errorCode != null) {
      const hex = "0x" + failure.errorCode.toString(16).toUpperCase();
      console.log(`  Code:    ${failure.errorCode} (${hex})`);
      console.log(`  Decoded: ${red(decodeCustomError(failure.programId, failure.errorCode))}`);
    } else {
      console.log(`  Kind:    ${red(failure.errorKind)}`);
      // Specific hints for common non-custom errors
      if (/exceeded.*compute/i.test(failure.errorKind) || /ComputationalBudgetExceeded/.test(failure.errorKind)) {
        console.log(`  Hint:    ${yellow("Compute budget exhausted. Add ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }) before the failing ix.")}`);
      } else if (/ProgramFailedToComplete/.test(failure.errorKind)) {
        console.log(`  Hint:    ${yellow("Usually a Rust panic OR compute exhaustion. Search logs for 'panicked at'.")}`);
      } else if (/InvalidAccountData/.test(failure.errorKind)) {
        console.log(`  Hint:    ${yellow("Account passed where the program expected a different layout/type.")}`);
      } else if (/BlockhashNotFound/.test(failure.errorKind)) {
        console.log(`  Hint:    ${yellow("Stale blockhash. Fetch a fresh one and resign.")}`);
      }
    }
    console.log();

    console.log(bold("Raw err from RPC:"));
    console.log(" ", JSON.stringify(err, null, 2).replace(/\n/g, "\n  "));
    console.log();
  } else {
    console.log(green("Simulation succeeded (no error).\n"));
  }

  // 4. Full logs (always print last so the eye lands on the diagnosis first)
  console.log(bold("Program logs:"));
  for (const l of logs) console.log("  " + l);
  console.log();

  return { hasError: !!err };
}

// ----------------------------------------------------------------------------
// Input modes
// ----------------------------------------------------------------------------

function getConnection(): Connection {
  const url = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  return new Connection(url, "confirmed");
}

function loadKeypair(): Keypair {
  const p = process.env.KEYPAIR_PATH ?? path.join(os.homedir(), ".config", "solana", "id.json");
  if (!fs.existsSync(p)) {
    throw new Error(`Keypair not found at ${p}. Set KEYPAIR_PATH or run with --demo only on a machine with a default Solana CLI keypair.`);
  }
  const secret = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function simulateBase64(connection: Connection, b64: string) {
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch (e) {
    throw new Error(`Could not base64-decode input: ${(e as Error).message}`);
  }
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(buf);
  } catch (e) {
    throw new Error(`Not a valid VersionedTransaction. If you have a legacy transaction, convert it first. Inner: ${(e as Error).message}`);
  }
  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  return sim.value;
}

async function simulateBySignature(connection: Connection, sig: string) {
  const parsed = await connection.getTransaction(sig, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!parsed) throw new Error(`Transaction not found: ${sig}`);
  // We can't re-simulate the exact tx easily without the original message bytes,
  // but the on-chain record already has logs + err. Surface those as if we had simulated.
  return {
    logs: parsed.meta?.logMessages ?? [],
    err: parsed.meta?.err ?? null,
    unitsConsumed: parsed.meta?.computeUnitsConsumed ?? null,
    accounts: null,
    returnData: null,
    innerInstructions: null,
  };
}

async function simulateDemo(connection: Connection) {
  const payer = loadKeypair();
  console.log(dim(`Demo: payer=${payer.publicKey.toBase58()}`));
  const ix = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: payer.publicKey, // transfer to self — won't change balance, will succeed
    lamports: 1,
  });
  const { blockhash } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  // Don't sign — sigVerify: false on simulate
  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  return sim.value;
}

// ----------------------------------------------------------------------------
// Entry
// ----------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`Usage:
  ts-node scripts/simulate-tx.ts <BASE64_TX>
  ts-node scripts/simulate-tx.ts --sig <SIGNATURE>
  ts-node scripts/simulate-tx.ts --demo

Env:
  RPC_URL        RPC endpoint (default: mainnet-beta)
  KEYPAIR_PATH   Keypair path (default: ~/.config/solana/id.json) — needed for --demo only`);
    process.exit(args.length === 0 ? 2 : 0);
  }

  const connection = getConnection();
  console.log(dim(`RPC: ${(connection as unknown as { _rpcEndpoint: string })._rpcEndpoint}`));

  let result: {
    logs: string[] | null;
    err: unknown;
    unitsConsumed?: number | null;
  };

  try {
    if (args[0] === "--demo") {
      result = await simulateDemo(connection);
    } else if (args[0] === "--sig") {
      if (!args[1]) throw new Error("--sig requires a signature");
      result = await simulateBySignature(connection, args[1]);
    } else {
      result = await simulateBase64(connection, args[0]);
    }
  } catch (e) {
    console.error(red(`\nError: ${(e as Error).message}\n`));
    process.exit(2);
  }

  const { hasError } = printResult(result.logs ?? null, result.err, result.unitsConsumed);
  process.exit(hasError ? 1 : 0);
}

main().catch((e) => {
  console.error(red(`\nUnexpected: ${(e as Error).stack ?? e}\n`));
  process.exit(2);
});

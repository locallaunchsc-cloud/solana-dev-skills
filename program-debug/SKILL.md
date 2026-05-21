---
name: solana-program-debug
description: Use this skill when the user is debugging a Solana program error — reading transaction logs, decoding Anchor error codes, simulating transactions, handling compute budget issues, and diagnosing common runtime failures.
---

# Program Debug

## Overview

Solana errors are notoriously cryptic. A failing transaction usually surfaces as `custom program error: 0x1771` or `Program failed to complete` — no stack trace, no line number, no helpful message. The runtime returns a `u32` and you are expected to know which program threw it and what enum variant that maps to. This skill turns that opaque pipeline into a deterministic workflow: pull the logs, decode the error code against its program, fix the actual cause. The error code tables in `references/error-codes.md` cover the framework + system + token codes you will hit 90% of the time.

## When to use this skill

- A transaction failed and the user has a signature, log dump, or screenshot of an error
- An error like `Custom program error: 0x...`, `custom: N`, or an Anchor variant name appears
- Compute budget exhaustion: `exceeded CUs meter at BPF instruction` or `Computational budget exceeded`
- Account-size or realloc errors: `AccountDataTooSmall`, `InvalidRealloc`, `account data too small`
- Anchor IDL/discriminator mismatches after a redeploy: `InstructionFallbackNotFound`, `AccountDiscriminatorMismatch`
- Tests pass on `solana-test-validator` but fail on devnet/mainnet (or vice versa)
- `simulateTransaction` returns logs but the call hasn't been sent yet — you want to know what would happen

## Prerequisites

- `solana-cli` 2.x or 3.x (`solana --version`) — `solana confirm -v` works in both
- `anchor-cli` 0.31+ if the project uses Anchor (`anchor --version`)
- `jq` for log parsing (`jq --version`)
- Node 20+ and `@solana/web3.js` 1.95+ (or `@solana/kit` 2.x) for `scripts/simulate-tx.ts`
- An RPC URL set in `solana config set --url ...` or passed as `RPC_URL` env var

## Workflow

### 1. Get the full transaction logs

If the user has a signature, this is always step one — never guess from the error message alone.

```bash
solana confirm -v <SIGNATURE> --url <RPC_URL>
```

The `-v` flag dumps the program logs, compute units consumed per invocation, and the error. If you don't have a signature, ask for one — or for the logs the SDK printed.

### 2. If no signature exists yet, simulate

```bash
ts-node scripts/simulate-tx.ts
```

`simulateTransaction` runs the tx against the current state without paying fees or persisting. The script in `scripts/` pretty-prints logs, the error variant, compute units consumed, and decodes any known error code inline.

### 3. Read the logs top-down

Solana logs are a sequence of `Program <ID> invoke [depth]` → `Program log: ...` → `Program <ID> consumed N of M compute units` → `Program <ID> success|failed: ...`. The **innermost** `failed` line is the one that actually threw. Anything above it is just the call stack that led there.

Look for:
- `Program log: AnchorError caused by account: <name>. Error Code: <Name>. Error Number: <N>. Error Message: <msg>` — Anchor prints this for `#[error_code]` returns and constraint failures. You're done — go fix that account/constraint.
- `Program log: panicked at '...', src/lib.rs:LINE` — Rust panic. Source line included. Almost always an arithmetic overflow, unwrap on `None`, or index out of bounds.
- `Program failed to complete: exceeded CUs meter` — compute exhaustion. Go to step 7.
- Just `custom program error: 0xNNNN` with no Anchor log line — you're hitting a non-Anchor program (system, token, custom CPI target). Decode against that program's error enum.

### 4. Decode the error code

Match the hex/decimal against `references/error-codes.md`. Quick mental map:

| Range | Source |
|-------|--------|
| `0x0` – `0x8` | System program (0-8 decimal) — `AccountAlreadyInUse`, `ResultWithNegativeLamports`, etc. |
| `0x0` – `0x13` | SPL Token (0-19 decimal) — only when the failing program ID is Token / Token-2022 |
| `0x64` – `0x67` (100-103) | Anchor instruction layer (`InstructionMissing`, `InstructionFallbackNotFound`, etc.) |
| `0x7D0` – `0x7FA` (2000-2042) | Anchor constraint failures (`#[account(...)]` violations) |
| `0x9C4` – `0x9CA` (2500-2506) | Anchor `require!` family |
| `0xBB8` – `0xBC9` (3000-3017) | Anchor account checks (discriminator, owner, signer, etc.) |
| `0x100C` – `0x100E` (4100-4102) | Anchor misc (declared program id mismatch, etc.) |
| `0x1770` (6000) and up | **User-defined errors from `#[error_code]` enum** — look in the program's `error.rs` |

Always check **which program** the log line attributes the error to. `0x1` from the Token program is `InsufficientFunds`; `0x1` from your own program is the second variant of your `#[error_code]` enum's user range — completely unrelated. The `Program <ID> failed: custom program error: 0xNNNN` line tells you which program owns the code.

The `0x1770` offset is the most important thing to remember: the **first** custom error in any Anchor `#[error_code]` enum is `6000`, second is `6001`, etc. So `0x1772` is your enum's third variant.

### 5. Add targeted logging

If the error is generic (a `require!` you can't trace, a panic without context, a `0x0` custom error), add `msg!` calls and redeploy:

```rust
msg!("balance_before: {}, withdraw_amount: {}", ctx.accounts.vault.balance, amount);
require!(ctx.accounts.vault.balance >= amount, MyError::Insufficient);
```

Then stream logs live while reproducing:

```bash
solana logs <PROGRAM_ID> --url <RPC_URL>
```

`msg!` is cheap (~100 CUs) but burns CUs in production hot paths — strip them once fixed.

### 6. Reproduce locally on `solana-test-validator`

```bash
solana-test-validator --reset \
  --clone <ACCOUNT_PUBKEY> --url mainnet-beta \
  --clone-upgradeable-program <PROGRAM_ID> --url mainnet-beta
```

This forks specific accounts/programs from mainnet into a local fresh validator. You get instant logs, no rate limits, and you can attach `--clone` for every account the tx touches. Set `solana config set --url localhost` and rerun.

### 7. Diagnose compute budget exhaustion

If logs say `Program failed to complete: exceeded CUs meter` or `consumed N of N compute units` where N matches the limit:

- Find the inner-most program that ran out. Its `consumed X of Y` line shows how close to the limit it was.
- Default per-tx limit is **200,000 CUs**. Max is **1,400,000 CUs**.
- Raise it client-side **before** the failing instruction in the same transaction:

```ts
import { ComputeBudgetProgram } from "@solana/web3.js";

tx.add(
  ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), // priority fee
  yourFailingIx
);
```

If you're already at 1.4M and still exhausting, the real fix is in the program: reduce CPI count, replace `Vec` allocations with fixed-size arrays, pre-compute Pubkey derivations off-chain and pass them in instead of `find_program_address` (which is ~5,000 CUs per call).

### 8. Account size / realloc errors

- `AccountDataTooSmall` (system error `0x5` shifted) or Anchor `0xBC8` `AccountReallocExceedsLimit`: your `#[account(realloc = N, ...)]` is asking for more space than allowed (10,240 bytes per tx).
  - Fix: do reallocs in chunks across multiple transactions, or pick the final size at init time.
- `account data too small for instruction` on init: your `space` constraint didn't account for the 8-byte Anchor discriminator. Always `8 + std::mem::size_of::<MyAccount>()` or the Anchor-generated `MyAccount::INIT_SPACE + 8`.
- `Allocate: account already in use`: you're trying to `init` an account that's already initialized. Use `init_if_needed` (feature-gated, audit carefully) or skip the init.

### 9. Read the raw account state

When deserialization fails (`AccountDidNotDeserialize`, `BorshIoError`) the account data is on-chain but doesn't match what the program expects. Dump it raw:

```bash
solana account <ACCOUNT_PUBKEY> --url <RPC_URL> --output json-compact
```

The `data` field is base64. First 8 bytes are the Anchor discriminator — if those don't match what `anchor idl` shows for this account type, the account was written by a different program version. Either the IDL is stale or the account predates a struct change.

### 10. Check for a stale deploy

After `anchor build` and `anchor deploy`, the on-chain bytecode may be cached by RPC nodes for ~30s. Symptoms:
- `InstructionFallbackNotFound` (Anchor `0x65` / 101) immediately after deploy — discriminator changed but the cached program is old, or your client TS bindings are from a previous build.
- Mismatch between `target/idl/<program>.json` and the on-chain IDL (`anchor idl fetch <PROGRAM_ID>`).
- Fix: regenerate client bindings (`anchor build` does this), wait 30s, retry. If persistent, run `anchor idl upgrade <PROGRAM_ID> -f target/idl/<program>.json`.

## Common pitfalls

**1. `AnchorError: AccountNotEnoughKeys` (`0xBBD`, 3005)**
You passed fewer accounts than the instruction expects. Usually: forgot to include `system_program`, `rent`, `token_program`, or an associated token account. Cross-check the `#[derive(Accounts)]` struct with what your client builds.

**2. `InstructionFallbackNotFound` (`0x65`, 101 — Anchor framework code)**
The 8-byte instruction discriminator on your tx doesn't match any instruction in the deployed program, and your program has no fallback handler. Almost always one of:
- You rebuilt the program but didn't redeploy (or RPC is serving a cached old version).
- You renamed an instruction handler (changes the sighash-derived discriminator).
- Client is using a stale IDL — regenerate bindings (`anchor build` does this).
- You're calling the wrong program ID entirely.

(Note: `0x1771` = 6001 is the **second** variant in your program's `#[error_code]` user enum, not this framework error. Always check the program ID on the failing log line.)

**3. `Custom: 0x0` from System program (signer/lamport class)**
System program threw `AccountAlreadyInUse`. Common causes: trying to `createAccount` on an address that already exists, or passing the same signer twice in an instruction that expects distinct signers. Also surfaces on insufficient lamports for rent + the operation.

**4. `BorshIoError(unexpected length of input)` or `AccountDidNotDeserialize` (`0xBBB`, 3003)**
On-chain account data length doesn't match the struct the program tries to deserialize into. Causes:
- Struct field added/removed but old accounts weren't migrated.
- `realloc` shrunk the account below the new struct size.
- Wrong account passed (account belongs to a different type/program).

Dump the account (step 9) and check the size + discriminator.

**5. Compute unit exhaustion mid-CPI**
A CPI into Token / Metaplex / a complex pool consumes 50-200K CUs each. Three CPIs in a single instruction can blow the 200K default. Add `ComputeBudgetProgram.setComputeUnitLimit` (step 7) **before** debugging the logic — the logic is probably fine.

**6. `ConstraintSeeds` (`0x7D6`, 2006)**
The PDA you derived client-side doesn't match what `seeds = [...]` in the account constraint derives on-chain. Almost always a byte-order or encoding mismatch — e.g. you used `user.toBuffer()` but the program expects `user.toBytes()` of a different size, or you forgot the bump seed, or the seed `String` includes a hidden trailing byte. Reproduce both derivations in a test and compare bytes.

**7. `AccountOwnedByWrongProgram` (`0xBBF`, 3007)**
You passed an account but it's owned by a different program than the constraint expects. Most common: passing a Token-2022 account to a constraint that expects classic SPL Token (or vice versa). Add `token_program` to your accounts and use the matching `token::*` constraints.

**8. `RentExempt` failures (`AccountNotRentExempt` from runtime, or Anchor `0x7D5`)**
The account doesn't have enough lamports to be rent-exempt for its data size. Either fund it more on init (`Rent::get()?.minimum_balance(N)`) or — if you're shrinking via `realloc` — make sure you're not leaving the account below the new rent-exempt minimum.

**9. `IncorrectProgramId` for SPL Token**
You used the classic SPL Token program ID (`Tokenkeg...`) but the account is a Token-2022 account (`TokenzQd...`), or vice versa. Anchor 0.30+ has `token_program` as a typed constraint — use it.

**10. Tests pass locally, fail on devnet**
Three usual suspects:
- Local validator has no rent enforcement by default (some legacy setups). Devnet does.
- Local clock isn't real time — `Clock::get()?.unix_timestamp` returns whatever the validator says.
- You forgot to deploy to devnet. `anchor deploy --provider.cluster devnet`.

## References

- Anchor `ErrorCode` enum source: https://docs.rs/anchor-lang/latest/src/anchor_lang/error.rs.html
- Solana `ProgramError` source: https://docs.rs/solana-program-error/latest/solana_program_error/enum.ProgramError.html
- System program errors: https://docs.rs/solana-system-interface/latest/solana_system_interface/error/enum.SystemError.html
- SPL Token errors: https://docs.rs/spl-token/latest/spl_token/error/enum.TokenError.html
- Explorers — paste any signature:
  - https://explorer.solana.com/tx/<SIG>
  - https://solana.fm/tx/<SIG>
  - https://solscan.io/tx/<SIG>
- Compute budget docs: https://solana.com/docs/core/fees#compute-budget

## Lookup table

See `references/error-codes.md` for a comprehensive error code lookup table covering Anchor, System, and Token program errors with hex codes, decimal values, sources, meanings, and typical fixes.

## Simulate tx

See `scripts/simulate-tx.ts` to simulate a transaction and pretty-print logs, error codes, and compute units consumed. Run with `ts-node scripts/simulate-tx.ts <BASE64_TX>` or import the helpers to simulate an instruction list directly.

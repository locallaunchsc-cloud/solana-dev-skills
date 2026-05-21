# Solana Error Code Reference

When you see `Program <ID> failed: custom program error: 0xNNNN` in transaction logs, the meaning depends on **which program ID** is on that line. Decode the hex value against that program's error enum. The runtime does not (and cannot) tell you "this is an Anchor framework error vs a user error vs a Token error" — the hex is just a `u32` returned by the program.

Quick rule of thumb:

- If the program is the **System program** (`11111111111111111111111111111111`): look at the System table below. Codes are small (0-8).
- If the program is the **SPL Token program** (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`) or **Token-2022** (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`): use the Token table. Codes are also small (0-19).
- If the program is **your own Anchor program**:
  - Codes `100-103` = Anchor instruction layer
  - Codes `2000-2042` = Anchor constraint failures (`#[account(...)]`)
  - Codes `2500-2506` = Anchor `require!` family
  - Codes `3000-3017` = Anchor account checks
  - Codes `4100-4102` = Anchor misc
  - Codes `6000+` (`0x1770+`) = **your own `#[error_code]` enum variants**, indexed from the order they appear in source

The runtime sometimes encodes `ProgramError` variants in the upper 32 bits of a 64-bit value (e.g. `0x100000000` for `Custom(0)`, `0x200000000` for `InvalidArgument`). In transaction logs you almost always see just the lower 32 bits as plain hex.

---

## Anchor framework — Instructions (100-103)

| hex | decimal | source | meaning | typical fix |
|---|---|---|---|---|
| `0x64` | 100 | Anchor | `InstructionMissing` — instruction discriminator not provided | Client sent an empty / too-short instruction data buffer. Rebuild your tx using the generated client (`program.methods.foo(...)`). |
| `0x65` | 101 | Anchor | `InstructionFallbackNotFound` — no matching instruction, no fallback handler | Stale deploy or stale client IDL. Run `anchor build && anchor deploy`, regenerate client bindings, wait ~30s for RPC cache. |
| `0x66` | 102 | Anchor | `InstructionDidNotDeserialize` — program could not deserialize instruction args | Client encoded args with the wrong type or wrong order. Regenerate bindings; check `program.methods.foo(...)` argument types match the Rust handler. |
| `0x67` | 103 | Anchor | `InstructionDidNotSerialize` — program could not serialize instruction args | Rare on inbound. Usually surfaces in CPI builders — fix the args you're passing to the inner program. |

## Anchor framework — Events (1500)

| hex | decimal | source | meaning | typical fix |
|---|---|---|---|---|
| `0x5DC` | 1500 | Anchor | `EventInstructionStub` — program compiled without `event-cpi` feature | Add `event-cpi` to the program's `Cargo.toml` features list. |

## Anchor framework — Constraints (2000-2042)

These are `#[account(...)]` constraint violations. The Anchor log line above the error code names the failing account and constraint.

| hex | decimal | source | meaning | typical fix |
|---|---|---|---|---|
| `0x7D0` | 2000 | Anchor | `ConstraintMut` — account marked `mut` but not writable | Add `isWritable: true` in the client, or use `program.methods.foo().accounts({...})` which sets it automatically. |
| `0x7D1` | 2001 | Anchor | `ConstraintHasOne` — `has_one` field doesn't match | The struct field pointing at the related account holds a different pubkey than the one you passed. Fix client or update on-chain state. |
| `0x7D2` | 2002 | Anchor | `ConstraintSigner` — account required to sign but didn't | Add it as a signer client-side, or remove `Signer<'_>` / `signer` from the Rust constraint. |
| `0x7D3` | 2003 | Anchor | `ConstraintRaw` — raw `#[account(constraint = ...)]` expression evaluated false | Read the `Error Message:` line — that's your raw constraint message. Fix the state that makes it false. |
| `0x7D4` | 2004 | Anchor | `ConstraintOwner` — account owned by a different program | Pass the right account, or fix the `owner = ...` constraint. |
| `0x7D5` | 2005 | Anchor | `ConstraintRentExempt` — account not rent-exempt | Fund the account: `Rent::get()?.minimum_balance(data_len)`. |
| `0x7D6` | 2006 | Anchor | `ConstraintSeeds` — PDA derived from `seeds = [...]` doesn't match passed account | Client and program disagree on seeds. Re-derive `PublicKey.findProgramAddressSync([...], programId)` with the exact same seed bytes and bump. |
| `0x7D7` | 2007 | Anchor | `ConstraintExecutable` — executable flag mismatch | Usually means you passed a non-program account where one was expected (or vice versa). |
| `0x7D8` | 2008 | Anchor | `ConstraintState` — deprecated | Don't use `#[state]`. |
| `0x7D9` | 2009 | Anchor | `ConstraintAssociated` — ATA address mismatch | Re-derive with `getAssociatedTokenAddress(mint, owner)`. |
| `0x7DA` | 2010 | Anchor | `ConstraintAssociatedInit` — ATA init constraint failed | Pass the right `associated_token::mint` and `associated_token::authority` accounts. |
| `0x7DB` | 2011 | Anchor | `ConstraintClose` — `close` target mismatch | The `close = receiver` field doesn't point at the receiver you passed. |
| `0x7DC` | 2012 | Anchor | `ConstraintAddress` — account address doesn't match `address = ...` | You hard-coded an expected address and got a different one. |
| `0x7DD` | 2013 | Anchor | `ConstraintZero` — expected zero account discriminant | The account is already initialized. Use `init_if_needed` or pass a fresh keypair. |
| `0x7DE` | 2014 | Anchor | `ConstraintTokenMint` — token account's mint doesn't match constraint | Pass the right token account, or change `token::mint = ...`. |
| `0x7DF` | 2015 | Anchor | `ConstraintTokenOwner` — token account owner doesn't match | Check `token::authority = ...` matches the account's owner field. |
| `0x7E0` | 2016 | Anchor | `ConstraintMintMintAuthority` | Mint authority on the mint doesn't match `mint::authority = ...`. |
| `0x7E1` | 2017 | Anchor | `ConstraintMintFreezeAuthority` | Freeze authority mismatch. |
| `0x7E2` | 2018 | Anchor | `ConstraintMintDecimals` | Mint's decimals don't match `mint::decimals = ...`. |
| `0x7E3` | 2019 | Anchor | `ConstraintSpace` — `space = ...` doesn't match account data length | Use `space = 8 + MyAccount::INIT_SPACE` or compute manually including the 8-byte discriminator. |
| `0x7E4` | 2020 | Anchor | `ConstraintAccountIsNone` — a required account for the constraint is None | An `Option<Account<'info, T>>` was needed for the constraint to evaluate. Pass it. |
| `0x7E5` | 2021 | Anchor | `ConstraintTokenTokenProgram` | Wrong token program ID for this token account (classic vs Token-2022). |
| `0x7E6` | 2022 | Anchor | `ConstraintMintTokenProgram` | Wrong token program ID for this mint. |
| `0x7E7` | 2023 | Anchor | `ConstraintAssociatedTokenTokenProgram` | Wrong token program ID for this ATA. |
| `0x7E8` – `0x7F7` | 2024-2039 | Anchor | Token-2022 mint extension constraints (group pointer, metadata pointer, close authority, permanent delegate, transfer hook) | Match the extension on the actual mint, or remove the constraint. |
| `0x7F8` | 2040 | Anchor | `ConstraintDuplicateMutableAccount` | Two `mut` accounts in your instruction resolved to the same pubkey. Deduplicate. |
| `0x7F9` | 2041 | Anchor | `AccountAlreadyMigrated` | This Anchor account has already been migrated. |
| `0x7FA` | 2042 | Anchor | `AccountNotMigrated` — account must be migrated before exiting | Run the migration instruction first. |

## Anchor framework — `require!` family (2500-2506)

These come from `require!`, `require_eq!`, `require_keys_eq!`, etc. The accompanying log line includes the line number.

| hex | decimal | source | meaning | typical fix |
|---|---|---|---|---|
| `0x9C4` | 2500 | Anchor | `RequireViolated` — a `require!(expr)` evaluated false | Read the log to find the file/line. Fix the state. |
| `0x9C5` | 2501 | Anchor | `RequireEqViolated` | `require_eq!(a, b)` — values differ. |
| `0x9C6` | 2502 | Anchor | `RequireKeysEqViolated` | `require_keys_eq!(a, b)` — pubkeys differ. |
| `0x9C7` | 2503 | Anchor | `RequireNeqViolated` | `require_neq!(a, b)` — values equal. |
| `0x9C8` | 2504 | Anchor | `RequireKeysNeqViolated` | `require_keys_neq!(a, b)` — pubkeys equal. |
| `0x9C9` | 2505 | Anchor | `RequireGtViolated` | `require_gt!(a, b)` — a not > b. |
| `0x9CA` | 2506 | Anchor | `RequireGteViolated` | `require_gte!(a, b)` — a not >= b. |

## Anchor framework — Accounts (3000-3017)

| hex | decimal | source | meaning | typical fix |
|---|---|---|---|---|
| `0xBB8` | 3000 | Anchor | `AccountDiscriminatorAlreadySet` | Trying to init an account that already has a discriminator. Use a fresh account or `init_if_needed`. |
| `0xBB9` | 3001 | Anchor | `AccountDiscriminatorNotFound` — no discriminator on the account | The account exists but has no Anchor discriminator (likely raw lamport account, or zero-init via `system_program::create_account` without subsequent Anchor init). |
| `0xBBA` | 3002 | Anchor | `AccountDiscriminatorMismatch` — discriminator present but wrong type | You passed an account of a different Anchor type. Check the `Account<'info, T>` type matches what was actually stored. |
| `0xBBB` | 3003 | Anchor | `AccountDidNotDeserialize` — Borsh deserialization failed | Account layout changed. Dump raw bytes with `solana account ... --output json-compact`. Either migrate or rebuild with old struct. |
| `0xBBC` | 3004 | Anchor | `AccountDidNotSerialize` | Rare; usually a programming bug in your account setter. |
| `0xBBD` | 3005 | Anchor | `AccountNotEnoughKeys` — not enough account keys given | Client forgot to pass `system_program`, `rent`, `token_program`, an ATA, or another required account. Compare `#[derive(Accounts)]` against the client. |
| `0xBBE` | 3006 | Anchor | `AccountNotMutable` — account is not mutable | Mark it writable in the client (`{ pubkey, isWritable: true }`). |
| `0xBBF` | 3007 | Anchor | `AccountOwnedByWrongProgram` | Wrong program owns this account. Often Token vs Token-2022 mixup. |
| `0xBC0` | 3008 | Anchor | `InvalidProgramId` — program ID was not as expected | A `Program<'info, T>` account got the wrong pubkey. Use the typed `program.programId`. |
| `0xBC1` | 3009 | Anchor | `InvalidProgramExecutable` — program account not executable | Same — wrong account, not a deployed program. |
| `0xBC2` | 3010 | Anchor | `AccountNotSigner` | Add the account as a signer. |
| `0xBC3` | 3011 | Anchor | `AccountNotSystemOwned` — account not owned by system program | Usually surfaces on `init`: the payer or new account isn't a system-owned SOL account. |
| `0xBC4` | 3012 | Anchor | `AccountNotInitialized` | You passed an account that hasn't been initialized yet. |
| `0xBC5` | 3013 | Anchor | `AccountNotProgramData` | Pass the program data account derived from the upgrade authority, not the program account itself. |
| `0xBC6` | 3014 | Anchor | `AccountNotAssociatedTokenAccount` | The token account isn't an ATA — derive with `getAssociatedTokenAddress`. |
| `0xBC7` | 3015 | Anchor | `AccountSysvarMismatch` | Wrong sysvar pubkey. Use the constants from `@solana/web3.js` (`SYSVAR_RENT_PUBKEY`, etc.). |
| `0xBC8` | 3016 | Anchor | `AccountReallocExceedsLimit` — realloc > `MAX_PERMITTED_DATA_INCREASE` (10,240 bytes per tx) | Split the grow across multiple transactions. |
| `0xBC9` | 3017 | Anchor | `AccountDuplicateReallocs` | The same account was scheduled for realloc twice. Deduplicate. |

## Anchor framework — Misc (4100-4102)

| hex | decimal | source | meaning | typical fix |
|---|---|---|---|---|
| `0x1004` | 4100 | Anchor | `DeclaredProgramIdMismatch` — `declare_id!` doesn't match the actual deployed program ID | Update `declare_id!` to the deployed address and redeploy, or deploy to the declared address. `anchor keys list` shows the truth. |
| `0x1005` | 4101 | Anchor | `TryingToInitPayerAsProgramAccount` | You're trying to `init` the payer itself. Use separate accounts. |
| `0x1006` | 4102 | Anchor | `InvalidNumericConversion` | A `u64`→`u32` or similar cast overflowed. Use `try_into()` and handle the error. |

## Anchor framework — Deprecated (5000)

| hex | decimal | source | meaning | typical fix |
|---|---|---|---|---|
| `0x1388` | 5000 | Anchor | `Deprecated` — the API being used is deprecated | Check the Anchor changelog and migrate. |

## Anchor — User errors (6000+)

These are **your** `#[error_code]` enum variants. They start at `6000` (`0x1770`) and increment by 1 per variant in source order.

```rust
#[error_code]
pub enum MyError {
    InsufficientFunds,   // 6000 / 0x1770
    InvalidAmount,       // 6001 / 0x1771
    Unauthorized,        // 6002 / 0x1772
    // ...
}
```

To decode `0x1772`: subtract `0x1770` to get the variant index (`2`), look at the third variant in your enum.

The user can also set explicit values:

```rust
#[error_code]
pub enum MyError {
    #[msg("Not enough SOL")]
    InsufficientFunds = 6500,  // 0x1964
}
```

In that case use the explicit number.

---

## System program (0-8)

Source program ID: `11111111111111111111111111111111`. The log line will read `Program 11111111111111111111111111111111 failed: ...`.

| hex | decimal | source | meaning | typical fix |
|---|---|---|---|---|
| `0x0` | 0 | System | `AccountAlreadyInUse` — an account with the same address already exists | Use a fresh `Keypair.generate()`, or skip the create. |
| `0x1` | 1 | System | `ResultWithNegativeLamports` — not enough SOL for the operation | Fund the payer or the source account. |
| `0x2` | 2 | System | `InvalidProgramId` — program is not the System program | A CPI was routed wrong. |
| `0x3` | 3 | System | `InvalidAccountDataLength` — account data length doesn't match what was requested | Check the `space` argument to `create_account`. |
| `0x4` | 4 | System | `MaxSeedLengthExceeded` — seed length > 32 bytes | Truncate the seed. |
| `0x5` | 5 | System | `AddressWithSeedMismatch` — derived address doesn't match | Re-derive with `Pubkey::create_with_seed` using the same base, seed, and owner. |
| `0x6` | 6 | System | `NonceNoRecentBlockhashes` | Sysvar `RecentBlockhashes` empty — usually a test setup issue. |
| `0x7` | 7 | System | `NonceBlockhashNotExpired` — durable nonce isn't ready to advance | Wait or use a different blockhash. |
| `0x8` | 8 | System | `NonceUnexpectedBlockhashValue` | Nonce account has a different blockhash than expected. Re-fetch and retry. |

## SPL Token program (0-19)

Source program ID: `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` (classic) or `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` (Token-2022). Same numeric mapping for both for these codes.

| hex | decimal | source | meaning | typical fix |
|---|---|---|---|---|
| `0x0` | 0 | Token | `NotRentExempt` — lamport balance below rent-exempt threshold | Fund the token account or mint to the rent-exempt minimum for its size. |
| `0x1` | 1 | Token | `InsufficientFunds` — token balance too low | Source token account doesn't hold enough. Check balances. |
| `0x2` | 2 | Token | `InvalidMint` | The account isn't a valid mint. Check the pubkey. |
| `0x3` | 3 | Token | `MintMismatch` — account not associated with this mint | Token account's `mint` field differs from the mint you passed. |
| `0x4` | 4 | Token | `OwnerMismatch` | The signer isn't the token account's owner / authority. |
| `0x5` | 5 | Token | `FixedSupply` | Trying to mint more on a fixed-supply mint. |
| `0x6` | 6 | Token | `AlreadyInUse` — account already initialized | Use a fresh keypair, or skip init. |
| `0x7` | 7 | Token | `InvalidNumberOfProvidedSigners` | Multisig: wrong number of signer accounts passed. |
| `0x8` | 8 | Token | `InvalidNumberOfRequiredSigners` | Multisig: M-of-N count outside `[1, 11]`. |
| `0x9` | 9 | Token | `UninitializedState` | Account exists but token state isn't initialized. Call the init instruction. |
| `0xA` | 10 | Token | `NativeNotSupported` — instruction does not support native (wrapped SOL) tokens | Use a different instruction or unwrap first. |
| `0xB` | 11 | Token | `NonNativeHasBalance` — can't close a non-native account with balance > 0 | Transfer or burn the balance first. |
| `0xC` | 12 | Token | `InvalidInstruction` | Discriminator on the instruction data doesn't match any Token instruction. Use `@solana/spl-token` helpers. |
| `0xD` | 13 | Token | `InvalidState` | Account is in a state that doesn't allow this op (e.g. frozen, or wrong multisig state). |
| `0xE` | 14 | Token | `Overflow` | Arithmetic overflow in the Token op. Check amount. |
| `0xF` | 15 | Token | `AuthorityTypeNotSupported` | This authority type can't be set on this account. |
| `0x10` | 16 | Token | `MintCannotFreeze` | Mint has no freeze authority configured. |
| `0x11` | 17 | Token | `AccountFrozen` | Token account is frozen. Owner of the freeze authority must thaw it. |
| `0x12` | 18 | Token | `MintDecimalsMismatch` | `transfer_checked` was given a `decimals` argument that doesn't match the mint. |
| `0x13` | 19 | Token | `NonNativeNotSupported` | Instruction requires the native SOL wrapper. |

## Solana runtime — `ProgramError` (built-in variants)

These are returned by programs but defined in the Solana SDK. They surface in logs as text (`Program failed: insufficient funds`) more often than as raw hex. If you do see them as hex, the runtime sometimes encodes them as `0xXX00000000` (32-bit shifted) — strip the trailing zeros to get the variant number listed below.

| variant | numeric | meaning |
|---|---|---|
| `Custom(N)` | `N` (passed through as-is) | Wraps program-specific errors. The whole point of all the tables above. |
| `InvalidArgument` | 1 | A non-account argument was invalid. |
| `InvalidInstructionData` | 2 | Instruction data is malformed. |
| `InvalidAccountData` | 3 | Account data is malformed for the requested operation. |
| `AccountDataTooSmall` | 4 | Account data buffer too small for the write. |
| `InsufficientFunds` | 5 | Not enough lamports. |
| `IncorrectProgramId` | 6 | A program account is not the expected program. |
| `MissingRequiredSignature` | 7 | A required signer didn't sign. |
| `AccountAlreadyInitialized` | 8 | Trying to init an account that's already initialized. |
| `UninitializedAccount` | 9 | Account expected to be initialized but isn't. |
| `NotEnoughAccountKeys` | 10 | Instruction received fewer accounts than needed. |
| `AccountBorrowFailed` | 11 | A `&mut` borrow on an account failed (usually duplicate `mut` borrow). |
| `MaxSeedLengthExceeded` | 12 | A PDA seed exceeds 32 bytes. |
| `InvalidSeeds` | 13 | Seeds + bump don't produce a valid off-curve address. |
| `BorshIoError` | 14 | Borsh serialization/deserialization failed. Account size or struct mismatch. |
| `AccountNotRentExempt` | 15 | Account balance below rent-exempt threshold. |
| `UnsupportedSysvar` | 16 | Tried to read a sysvar that isn't supported. |
| `IllegalOwner` | 17 | Account owner not allowed for this operation. |
| `MaxAccountsDataAllocationsExceeded` | 18 | Per-tx account data growth budget exceeded. |
| `InvalidRealloc` | 19 | Realloc didn't preserve invariants (e.g. shrink below current size while expected to grow). |
| `MaxInstructionTraceLengthExceeded` | 20 | Too many nested CPIs. |
| `BuiltinProgramsMustConsumeComputeUnits` | 21 | Internal — builtin program returned without consuming CUs. |
| `InvalidAccountOwner` | 22 | Account's owner doesn't match what the instruction expects. |
| `ArithmeticOverflow` | 23 | Checked arithmetic op overflowed. |
| `Immutable` | 24 | Account or program is marked immutable. |
| `IncorrectAuthority` | 25 | Provided authority doesn't match the expected authority. |

---

## How transactions report errors

`TransactionError` (outer, from the runtime) wraps `InstructionError` (per-instruction). The most common shape you see in RPC responses:

```json
{ "err": { "InstructionError": [0, { "Custom": 6001 }] } }
```

That means: instruction index `0` failed with custom error `6001` (`0x1771`). If the failing program was your Anchor program, that's the second variant of your `#[error_code]` enum.

Other shapes:

- `{ "InstructionError": [0, "ProgramFailedToComplete"] }` — usually CU exhaustion or panic.
- `{ "InstructionError": [0, "ComputationalBudgetExceeded"] }` — explicitly out of CUs.
- `{ "InstructionError": [0, "InvalidAccountData"] }` — built-in `ProgramError::InvalidAccountData`. See the ProgramError table.
- `"BlockhashNotFound"` — your tx's recent blockhash expired before landing. Resubmit with a fresh one.
- `"AlreadyProcessed"` — duplicate tx signature. Already landed. Check the previous result.

---

## Sources

- Anchor `ErrorCode` enum: https://docs.rs/anchor-lang/latest/anchor_lang/error/enum.ErrorCode.html
- Anchor source: https://github.com/coral-xyz/anchor/blob/master/lang/src/error.rs
- Solana `ProgramError`: https://docs.rs/solana-program/latest/solana_program/program_error/enum.ProgramError.html
- System program errors: https://docs.rs/solana-system-interface/latest/solana_system_interface/error/enum.SystemError.html
- SPL Token errors: https://docs.rs/spl-token/latest/spl_token/error/enum.TokenError.html
- SPL Token source: https://github.com/solana-program/token/blob/main/interface/src/error.rs
- Compute budget: https://solana.com/docs/core/fees#compute-budget

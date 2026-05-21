# Anchor `#[account(...)]` Constraint Cheatsheet

Quick reference for every Anchor account constraint, what it proves, when to use it, and the common ways developers misuse it. Anchor 0.30+.

A constraint goes inside `#[account(...)]` on a field of a `#[derive(Accounts)]` struct. Multiple constraints are comma-separated. Constraints are evaluated in declaration order — order matters when later constraints reference earlier fields.

---

## `init`

Creates the account: invokes the System program to allocate space, pays rent, and sets the owner to the current program. Requires `payer` and `space` (and the System program in scope).

```rust
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = user, space = 8 + Counter::INIT_SPACE)]
    pub counter: Account<'info, Counter>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}
```

**When to use:** creating fresh program-owned state. **Mistakes:** wrong `space` (use `INIT_SPACE` from `#[derive(InitSpace)]` plus 8 for the discriminator); forgetting `mut` on the payer; missing the System program.

---

## `init_if_needed`

Same as `init`, but skipped if the account already exists. Requires the `init-if-needed` Cargo feature on `anchor-lang`.

```rust
#[account(
    init_if_needed,
    payer = user,
    space = 8 + UserStats::INIT_SPACE,
    seeds = [b"stats", user.key().as_ref()],
    bump,
)]
pub stats: Account<'info, UserStats>,
```

**When to use:** sparingly — when an account may already exist and the caller shouldn't care. **Mistakes:** the canonical footgun. If the body of the instruction overwrites fields unconditionally, attackers can reinit a victim's account. Always check whether the account was freshly created (e.g. by comparing fields to `default()`) before writing authority-bearing fields.

---

## `mut`

Marks an account as writable for the instruction. Required for any account whose lamports or data change.

```rust
#[account(mut)]
pub vault: Account<'info, Vault>,
```

**When to use:** every account you write to, every account you close, every payer. **Mistakes:** forgetting it on a token account being transferred from, or on the recipient of a `close = ...`.

---

## `signer`

Asserts `is_signer == true`. The `Signer<'info>` wrapper is the idiomatic form; `#[account(signer)]` on `AccountInfo` works too.

```rust
pub user: Signer<'info>,                        // idiomatic
#[account(signer)] pub user: AccountInfo<'info>, // equivalent, no type info
```

**When to use:** any authority. **Mistakes:** assuming `has_one = user` implies signer-ness — it does not; `has_one` only checks equality.

---

## `has_one = field`

Asserts the field with that name on the current account equals the pubkey of another account in the struct. The most important relational constraint.

```rust
#[account(has_one = authority, has_one = mint)]
pub vault: Account<'info, Vault>,
pub authority: Signer<'info>,
pub mint: Account<'info, Mint>,
```

**When to use:** any time one account stores a reference to another. **Mistakes:** forgetting that `has_one` only checks the pubkey equals — it does not check that the *referenced account is what it claims to be*. Pair with type-checked Anchor wrappers or `owner = ...`.

---

## `constraint = <expr>`

Generic boolean predicate evaluated against the deserialized struct. The escape hatch when nothing else fits.

```rust
#[account(constraint = vault.locked_until < Clock::get()?.unix_timestamp @ ErrorCode::StillLocked)]
pub vault: Account<'info, Vault>,
```

**When to use:** business-logic preconditions that should fail the instruction at deserialize time. **Mistakes:** writing checks that read from `AccountInfo` (raw bytes) without an owner check; using `constraint` for things `has_one` or `address` express more declaratively.

---

## `owner = <pubkey>`

Asserts the account's owner field (the program that owns it) equals the given pubkey.

```rust
#[account(owner = spl_token::ID)]
pub token_account: AccountInfo<'info>,
```

**When to use:** any time you accept a raw `AccountInfo`/`UncheckedAccount` that should be owned by a specific program (token accounts, other-program PDAs). **Mistakes:** assuming Anchor's typed `Account<'info, T>` doesn't need this — it doesn't, it checks automatically. But raw accounts always do.

---

## `seeds = [...], bump`

Asserts the account is a PDA derived from the given seeds. Without an `= <expr>` on `bump`, Anchor calls `find_program_address` (expensive but always canonical). With `bump = stored_bump`, it uses `create_program_address` (cheap, but you must store the canonical bump on init).

```rust
// at init — derive canonical bump and store it
#[account(
    init,
    payer = user,
    space = 8 + Vault::INIT_SPACE,
    seeds = [b"vault", user.key().as_ref()],
    bump,
)]
pub vault: Account<'info, Vault>,

// later — re-validate using stored bump (cheap, canonical)
#[account(seeds = [b"vault", user.key().as_ref()], bump = vault.bump)]
pub vault: Account<'info, Vault>,
```

**When to use:** every PDA. **Mistakes:** accepting `bump` as an instruction argument (lets attacker pick non-canonical bumps); forgetting to store the canonical bump at init; seeds that don't include enough context to prevent cross-instruction collisions.

---

## `close = <recipient>`

Closes the account at the end of the instruction: transfers all lamports to `recipient`, zeros the data, and sets the discriminator to the closed-account marker.

```rust
#[account(mut, close = owner, has_one = owner)]
pub position: Account<'info, Position>,
pub owner: Signer<'info>,
```

**When to use:** any time you want to deallocate program state and refund rent. **Mistakes:** using `close` without a `has_one` or signer check on the recipient — attackers can otherwise redirect lamports.

---

## `address = <pubkey>`

Asserts the account's key equals the given pubkey. Use for known-good addresses like a program ID, a treasury PDA, or a hardcoded admin.

```rust
#[account(address = config::ADMIN_PUBKEY)]
pub admin: Signer<'info>,
```

**When to use:** singletons, known constants, hardcoded authorities. **Mistakes:** hardcoding a pubkey that should be configurable; using `address` where `has_one` (relative to another account) would be more flexible.

---

## `payer = <signer>`

Required by `init` / `init_if_needed` / `realloc`. Specifies which signer pays rent.

```rust
#[account(init, payer = user, space = 8 + Foo::INIT_SPACE)]
pub foo: Account<'info, Foo>,
#[account(mut)]
pub user: Signer<'info>,
```

**Mistakes:** forgetting `mut` on the payer; setting `payer` to a non-signer.

---

## `space = <usize>`

Bytes to allocate. Must include the 8-byte discriminator for `#[account]` structs.

```rust
#[account(init, payer = user, space = 8 + Vault::INIT_SPACE)]
pub vault: Account<'info, Vault>,
```

**Idiom:** derive `InitSpace` on the account struct so `T::INIT_SPACE` gives the field-byte total; add 8 for the discriminator. **Mistakes:** miscounting strings/vecs; over-allocating wastes rent; under-allocating breaks subsequent writes.

---

## `zero`

Asserts the account is already allocated but its discriminator is all zeros (i.e. uninitialized). Lets you split allocation from initialization across two transactions, useful for very large accounts (>10KB) that can't be `init`'d in a single tx.

```rust
#[account(zero)]
pub big_account: Account<'info, BigAccount>,
```

**When to use:** accounts too large for a single-tx init. **Mistakes:** confusing this with `init` — `zero` doesn't allocate.

---

## `rent_exempt = enforce | skip`

Controls whether the account is required to be rent-exempt after the instruction. Defaults to `enforce` for new accounts. Rarely needed explicitly.

```rust
#[account(mut, rent_exempt = skip)]
pub will_be_closed: Account<'info, Temp>,
```

**When to use:** the only common case is `skip` on an account you're about to close, to avoid a sanity check. **Mistakes:** using `skip` where it lets an account drift out of rent-exemption and get garbage-collected.

---

## `token::mint = ...`, `token::authority = ...`, `token::token_program = ...`

For `Account<'info, TokenAccount>` — verifies the token account's `mint` and `owner` fields, and optionally the token program (Token vs Token-2022).

```rust
#[account(
    mut,
    token::mint = usdc_mint,
    token::authority = vault_pda,
)]
pub vault_token_account: Account<'info, TokenAccount>,
```

**When to use:** every token account in every instruction. **Mistakes:** omitting `token::authority` — an attacker can pass a real USDC account they own.

---

## `mint::decimals = ...`, `mint::authority = ...`, `mint::freeze_authority = ...`, `mint::token_program = ...`

For `Account<'info, Mint>` — verifies the mint's decimals, authority, freeze authority, and program.

```rust
#[account(
    mint::decimals = 6,
    mint::authority = mint_authority_pda,
)]
pub usdc_mint: Account<'info, Mint>,
```

**When to use:** any time the program assumes specific mint properties (e.g. 6 decimals for price math). **Mistakes:** assuming a mint has fixed properties without asserting them.

---

## `associated_token::mint = ...`, `associated_token::authority = ...`, `associated_token::token_program = ...`

For `Account<'info, TokenAccount>` when the account is the canonical Associated Token Account for a (mint, authority) pair. Anchor checks the derivation.

```rust
#[account(
    init_if_needed,
    payer = user,
    associated_token::mint = mint,
    associated_token::authority = user,
)]
pub user_ata: Account<'info, TokenAccount>,
pub mint: Account<'info, Mint>,
#[account(mut)]
pub user: Signer<'info>,
pub token_program: Program<'info, Token>,
pub associated_token_program: Program<'info, AssociatedToken>,
pub system_program: Program<'info, System>,
```

**When to use:** any ATA. **Mistakes:** forgetting the AssociatedToken program in the accounts struct; using a regular `init` on an ATA (wrong derivation).

---

## `realloc = <usize>, realloc::payer = <signer>, realloc::zero = <bool>`

Resizes an existing account. The payer covers (or receives back) the rent difference. `realloc::zero` controls whether new bytes are zero-initialized.

```rust
#[account(
    mut,
    realloc = 8 + new_size,
    realloc::payer = user,
    realloc::zero = false,
)]
pub data: Account<'info, DynamicData>,
```

**When to use:** growing or shrinking variable-length state. **Mistakes:** `realloc::zero = false` leaving stale data readable from the new range; shrinking past existing data without zeroing.

---

## Composite usage

The full pattern for a token-vault PDA owned by your program:

```rust
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        has_one = authority,
        seeds = [b"vault", authority.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    pub authority: Signer<'info>,

    #[account(
        mut,
        token::mint = vault.mint,
        token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = vault.mint,
        token::authority = authority,
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
```

Five constraints, five proofs: vault is the right PDA for this authority, authority signed, the vault's token account holds the right mint and is owned by the vault PDA, the recipient's token account holds the right mint and is owned by the authority. There is no untyped pubkey left.

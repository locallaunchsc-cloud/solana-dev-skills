---
name: solana-anchor-scaffold
description: Use this skill when the user wants to bootstrap a new Solana Anchor program from scratch — install toolchain, scaffold project, write a first instruction, build, test, and deploy.
---

# Anchor Scaffold

## Overview
Anchor is the de facto Rust framework for Solana programs. It generates the account-validation boilerplate, account discriminators, IDL, and a TypeScript client so you can focus on instruction logic instead of byte layouts. This skill takes a user from zero installed tooling to a deployed counter program on devnet in roughly 10 minutes.

## When to use this skill
- "I want to start a new Solana program."
- "How do I scaffold an Anchor project?"
- "Help me write my first on-chain instruction."
- "Deploy a Solana program to devnet."
- The user is on a fresh machine and needs the Solana / Rust / Anchor toolchain installed.

Do not use this skill for SPL-token-only flows, client-only dApp work, or non-Anchor native programs.

## Prerequisites
Versions verified May 2026: Anchor `1.0.2`, Solana CLI / Agave `3.0.10` (stable) or `4.0.0` (just released, fine for dev), Rust `1.91+`, Node `20+`, Yarn.

### One-line installer (recommended)
The Solana Foundation maintains a script that installs Rust, Solana CLI, Anchor, and surfpool:

```bash
curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash
```

After it finishes, restart your shell and verify:

```bash
rustc --version        # rustc 1.91.1 or newer
solana --version       # solana-cli 3.0.10 (or 4.x)
anchor --version       # anchor-cli 1.0.2
node --version         # v20+
yarn --version
```

### Manual install (if the one-liner fails)
```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"

# Solana CLI (Agave)
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# avm (Anchor Version Manager) + Anchor CLI
cargo install --git https://github.com/solana-foundation/anchor avm --force
avm install 1.0.2
avm use 1.0.2
```

### Create a local wallet
Anchor needs a default keypair at `~/.config/solana/id.json`. If `solana address` errors, create one:

```bash
solana-keygen new --no-bip39-passphrase
solana config set --url localhost
```

## Workflow

### 1. Scaffold the project
```bash
anchor init hello-program
cd hello-program
```

This generates:
```
hello-program/
├── Anchor.toml              # cluster, wallet, program IDs, test runner
├── Cargo.toml               # workspace
├── programs/hello-program/
│   ├── Cargo.toml
│   └── src/lib.rs           # your program
├── tests/hello-program.ts   # default TS test
├── migrations/deploy.ts
├── tsconfig.json
└── package.json
```

### 2. Understand `Anchor.toml`
```toml
[toolchain]
anchor_version = "1.0.2"

[features]
resolution = true
skip-lint = false

[programs.localnet]
hello_program = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"

[programs.devnet]
hello_program = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"

[provider]
cluster = "Localnet"           # change to "Devnet" before `anchor deploy`
wallet = "~/.config/solana/id.json"

[scripts]
test = "yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts"
```

The `programs.<cluster>` table maps program name → on-chain program ID. Anchor reads this so the TS client knows where to send instructions.

### 3. Write the instruction
Replace `programs/hello-program/src/lib.rs` with the counter program in `scripts/hello-program.rs`. Key macros to know:

- `declare_id!(...)` — the program's on-chain address. Must match `target/deploy/hello_program-keypair.json`.
- `#[program]` — module containing instruction handlers. Each `pub fn` becomes a callable instruction.
- `#[derive(Accounts)]` — declares the accounts each instruction touches and enforces constraints (`init`, `mut`, `has_one`, `signer`, etc.) at runtime.
- `#[account]` — marks a struct as a program-owned account. Combine with `#[derive(InitSpace)]` so Anchor computes the byte size for you (then add 8 for the discriminator).
- `#[error_code]` — custom errors that surface cleanly in the client.

### 4. Sync the program ID
The keypair Anchor generates locally won't match the placeholder `declare_id!` value. Sync them once:

```bash
anchor keys sync
```

This rewrites `declare_id!` in `lib.rs` and the `[programs.*]` entries in `Anchor.toml` to match `target/deploy/hello_program-keypair.json`.

### 5. Build
```bash
anchor build
```

Expected output ends with:
```
   Compiling hello-program v0.1.0 ...
    Finished `release` profile [optimized] target(s) in 42.13s
```

Build artifacts:
- `target/deploy/hello_program.so` — the BPF binary
- `target/idl/hello_program.json` — IDL used by the TS client
- `target/types/hello_program.ts` — TypeScript types

### 6. Test on localnet
Drop `scripts/hello-program.test.ts` into `tests/` (overwrite the default), then:

```bash
anchor test
```

This spins up `solana-test-validator`, deploys, runs the test file, and tears the validator down. Expected output:

```
  hello-program
    ✔ initializes the counter to 0 (412ms)
    ✔ increments the counter (407ms)
    ✔ increments again (402ms)
    ✔ rejects increment from a non-authority signer

  4 passing (2s)
```

If you want a long-running validator for repeated runs:
```bash
solana-test-validator       # terminal 1
anchor test --skip-local-validator  # terminal 2
```

### 7. Deploy to devnet
```bash
solana config set --url devnet
solana airdrop 2                       # may need to retry; devnet faucet is rate-limited
solana balance
```

Edit `Anchor.toml`:
```toml
[provider]
cluster = "Devnet"
```

Then deploy:
```bash
anchor deploy
```

Expected output:
```
Deploying cluster: https://api.devnet.solana.com
Upgrade authority: ~/.config/solana/id.json
Deploying program "hello_program"...
Program path: target/deploy/hello_program.so...
Program Id: Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS

Deploy success
```

Verify on-chain:
```bash
solana program show <PROGRAM_ID> --url devnet
```

## Common pitfalls

1. **Anchor / Solana version skew.** Anchor 1.0.x expects Solana CLI 2.x or 3.x. If `anchor build` fails with `error[E0658]` or `unresolved import 'solana_program'`, you almost certainly have an old toolchain. Run `avm use 1.0.2` and `agave-install update`.

2. **`declare_id!` doesn't match the deploy keypair.** After the first `anchor build`, always run `anchor keys sync`. Otherwise `anchor test` fails with `DeclaredProgramIdMismatch` (Anchor error `4100`).

3. **No local wallet.** `solana-keygen new` must have been run at least once, or `anchor test` dies with `Error: No such file or directory (os error 2)` reading `id.json`.

4. **Insufficient SOL for deploy.** A small program costs ~1.5 SOL of rent on devnet. The devnet faucet caps at 2 SOL per request and rate-limits hard. If `airdrop` fails, use https://faucet.solana.com or wait 8 hours.

5. **Forgot the 8-byte discriminator in `space`.** Anchor prepends an 8-byte discriminator to every account. `space = 8 + Counter::INIT_SPACE` is the safe pattern; bare `space = 40` will silently truncate the next field you add.

6. **Test file imports the wrong workspace key.** `anchor.workspace.HelloProgram` is the camelCase of your `Cargo.toml` `name`. If you renamed the program, update the import and the workspace lookup or you'll get `Cannot read properties of undefined`.

## References
- Anchor docs: https://www.anchor-lang.com/docs
- Anchor source: https://github.com/solana-foundation/anchor
- Solana CLI install: https://docs.anza.xyz/cli/install
- Solana program docs: https://solana.com/docs/programs/anchor
- Devnet faucet: https://faucet.solana.com
- Solana cookbook: https://solana.com/developers/cookbook

## Example program
See `scripts/hello-program.rs` for the working counter program shown in the workflow. Run with `scripts/hello-program.test.ts` (copy into `tests/` after `anchor init`).

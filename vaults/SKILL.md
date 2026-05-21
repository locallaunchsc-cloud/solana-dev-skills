---
name: solana-vaults
description: Use this skill when the user wants to interact with onchain vaults on Solana — depositing into managed strategy vaults (Drift Vaults, Jito Vaults, Kamino, Marginfi, Meteora) or building automated yield products. Covers deposit/withdraw, share token accounting, performance fees, and lockup mechanics.
---

# Solana Vaults

## Overview

A **vault** on Solana is a smart-contract bucket that pools capital from many depositors and routes it through a single strategy — perp market making, lending, LP provision, restaking, basis trades — managed by a delegate or curator. Depositors receive **share tokens** (or share accounting in a PDA) representing a proportional claim on the underlying pool, which grows or shrinks with strategy P&L net of fees.

Per Mert Mumtaz (Helius CEO), **vaults are a top-5 Solana priority for 2026**: they let stablecoin holders earn delta-neutral yield without running the strategy themselves, they compose with lending and perp protocols natively, and they're the dominant primitive for "DeFi without an interface" — agents, wallets, and apps embed vault deposits as a single button. Total vault TVL across the major Solana platforms now exceeds **$5B** (Kamino alone is ~$2.4B per DeFiLlama as of Q2 2026).

The major Solana vault platforms covered here:
- **Drift Vaults** — permissionless delegate-managed vaults on top of Drift perps v2 (market making, basis, JLP hedging). $200M+ TVL.
- **Kamino** — automated lending + concentrated-liquidity vaults; #1 by TVL on Solana.
- **Jito Vaults** — restaking vaults that mint Vault Receipt Tokens (VRTs) backed by SPL tokens delegated to operators.
- **Marginfi** — lending banks with mrgnLST liquid staking and isolated-mode vaults.
- **Meteora** — Alpha Vaults (pre-sale anti-bot vaults) and DLMM vaults for LP automation.

This skill ships working deposit scripts for **Drift Vaults** and **Kamino Lend** (both have stable, public TypeScript SDKs) and documents the integration pattern for the others.

## When to use this skill

- "Deposit USDC into a Drift vault" / "How do I interact with the Turbocharger or Circuit vault?"
- "Lend USDC on Kamino and read my share balance"
- "Stake into a Jito VRT" / "How does restaking on Solana work?"
- "Build a yield aggregator that routes USDC across Solana vaults"
- "Wrap a vault deposit in an agent action for my app"
- "Withdraw from a vault with a lockup epoch"

Not for: spot DEX swaps (see `jupiter-swap` skill), launching a fungible token (see `token-launch`), or writing the vault program itself (see `anchor-scaffold` + read the Drift Vaults source as a reference impl).

## Prerequisites

Pin these versions — verified against mainnet-beta on 2026-05-21:

```json
{
  "dependencies": {
    "@solana/web3.js": "1.98.0",
    "@solana/spl-token": "0.4.14",
    "@coral-xyz/anchor": "0.30.1",
    "@drift-labs/sdk": "2.122.0-beta.0",
    "@drift-labs/vaults-sdk": "0.3.4",
    "@kamino-finance/klend-sdk": "7.3.15",
    "bn.js": "5.2.1",
    "bs58": "6.0.0",
    "dotenv": "16.4.5"
  },
  "devDependencies": {
    "typescript": "5.6.3",
    "tsx": "4.19.2",
    "@types/node": "22.9.0",
    "@types/bn.js": "5.1.5"
  }
}
```

Environment:

```bash
# .env
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY   # Helius recommended for vault txs (compute, priority fees)
WALLET_SECRET=base58-encoded-keypair-secret
```

You will need:
- **USDC mainnet**: mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`. Most vaults on this list quote in USDC.
- A funded wallet with ~0.05 SOL for fees and rent (vault depositor PDAs are ~0.012 SOL rent-exempt).
- An RPC that supports `simulateTransaction` with replaceRecentBlockhash — Helius, Triton, or QuickNode. Free public RPC will rate-limit you mid-deposit.

## Workflow

### Core concepts

#### Shares vs. underlying

When you deposit `X` USDC into a vault, the program records your **shares**, not your USDC. Shares are minted at the current `pricePerShare = totalEquity / totalShares`. Your underlying balance at any time is `yourShares * pricePerShare`. If strategy P&L is +10%, `pricePerShare` rises 10% and your USDC-equivalent balance rises 10% without your share count changing. **Never display share counts to users as "your balance" — always convert to underlying first.**

Some vaults (Drift, Kamino kvaults, Jito) tokenize shares as transferable SPL tokens; others (older Drift vaults, Marginfi banks) keep shares inside a PDA. Tokenized shares are composable (you can post them as collateral elsewhere); PDA shares are simpler and cheaper.

#### Deposit flow (general shape)

1. Derive the **VaultDepositor PDA** (or load your obligation/account) from `[vault_pubkey, authority_pubkey]`.
2. If first-time deposit, send an `initializeVaultDepositor` ix (creates the PDA, pays rent).
3. Get a USDC ATA on your wallet, ensure sufficient balance.
4. Call `deposit(vaultDepositor, amount)` — the program transfers USDC from your ATA, mints shares to the depositor record, and updates `totalShares` / `totalEquity`.
5. Confirm with `getVaultDepositor()` and convert shares → underlying using current `pricePerShare`.

#### Withdraw flow

Most strategy vaults have a **withdraw request → finalization** two-step because the manager needs time to unwind positions:

1. `requestWithdraw(vaultDepositor, sharesOrAmount, withdrawUnit)` — locks the requested shares at the current price-per-share and starts the `redeem_period` timer.
2. Wait `redeem_period` (Drift mainnet default: 7 days for most vaults, 24 hours for short-lockup ones).
3. `withdraw(vaultDepositor)` — burns the locked shares, transfers USDC back. If pricePerShare dropped during the wait, you receive less than originally quoted (this is intentional — withdrawers absorb their pro-rata of any drawdown).

Kamino lending (non-locked) skips the request step — you call `withdraw` and get USDC immediately if the reserve has liquidity.

#### Lockups and epochs

- **Drift Vaults**: per-vault `redeem_period` (seconds). Cancel a pending request with `cancelRequestWithdraw`.
- **Jito Vaults**: epoch-based (Solana epoch ≈ 2 days). Cooldown spans multiple epochs for slashing safety.
- **Kamino lockup vaults** (e.g. JTO liquidity program): 30-day lock, then continuous unlock.
- **Meteora Alpha Vaults**: deposit window → purchase window → vesting; no withdraw before vesting starts.

Always check the specific vault's parameters before quoting a withdrawal time to a user.

#### Performance fees and high-water marks

Drift Vaults charge fees in two places:
- **Management fee** (annualized, accrued continuously, paid to manager regardless of P&L).
- **Profit share** (a.k.a. performance fee) — typically 20–30%, charged **only on new profits above the high-water mark (HWM)** per depositor.

The HWM is per-depositor, not per-vault: if you deposited at HWM=$1.00/share and the vault drew down to $0.95 then rallied to $1.05, you pay profit share on the $0.05 above your HWM, not on the full $0.10 recovery. New depositors who entered at $0.95 pay on the full $0.10. This makes profit share fair across cohorts but means **you cannot back out vault APY from price-per-share alone** — net APY depends on your entry point.

Kamino lending has no profit share — just a spread between borrow APY and supply APY plus a reserve protocol fee.

### Provider-by-provider

#### Drift Vaults

SDK: `@drift-labs/vaults-sdk` ([npm](https://www.npmjs.com/package/@drift-labs/vaults-sdk), [GitHub](https://github.com/drift-labs/drift-vaults)).

Pattern (see `scripts/deposit-drift-vault.ts` for the full runnable version):

```typescript
import { VaultClient, getVaultDepositorAddressSync, VAULT_PROGRAM_ID } from '@drift-labs/vaults-sdk';
import { DriftClient, BulkAccountLoader } from '@drift-labs/sdk';

const vaultClient = new VaultClient({ driftClient, program });
const vaultPubkey = new PublicKey('...');                    // e.g. Turbocharger, Circuit, hJLP
const vaultDepositor = getVaultDepositorAddressSync(VAULT_PROGRAM_ID, vaultPubkey, wallet.publicKey);

// First deposit creates the depositor PDA atomically:
const sig = await vaultClient.deposit(
  vaultDepositor,
  new BN(100_000_000),                                       // 100 USDC (6 decimals)
  { authority: wallet.publicKey, vault: vaultPubkey }        // init on first deposit
);

const vd = await vaultClient.getVaultDepositor(vaultDepositor);
console.log('Shares:', vd.vaultShares.toString());
```

Find live vault pubkeys at https://app.drift.trade/vaults/strategy-vaults (click a vault → copy the pubkey from the URL).

Withdraw: `requestWithdraw(vaultDepositor, sharesOrAmount, WithdrawUnit.SHARES | WithdrawUnit.TOKEN)` → wait `redeem_period` → `withdraw(vaultDepositor)`. Cancel with `cancelRequestWithdraw(vaultDepositor)`.

#### Kamino Lend

SDK: `@kamino-finance/klend-sdk` ([npm](https://www.npmjs.com/package/@kamino-finance/klend-sdk), [GitHub](https://github.com/Kamino-Finance/klend-sdk)).

Pattern (see `scripts/deposit-kamino-vault.ts`):

```typescript
import { KaminoMarket, KaminoAction, VanillaObligation, PROGRAM_ID } from '@kamino-finance/klend-sdk';
import { address } from '@solana/kit';

const MAIN_MARKET = address('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
const market = await KaminoMarket.load(connection, MAIN_MARKET);

const action = await KaminoAction.buildDepositTxns(
  market,
  '100000000',                                               // 100 USDC raw
  'USDC',
  new VanillaObligation(PROGRAM_ID)
);
// action.setupIxs, action.lendingIxs, action.cleanupIxs — bundle into a versioned tx
```

Other Kamino markets:
- JLP market: `DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek`
- Altcoin market: `ByYiZxp8QrdN9qbdtaAiePN8AAr3qvTPppNJDpf5DVJ5`

Kamino has separate **kvaults** (concentrated-liquidity automated LP vaults) using `kliquidity-sdk` — different surface area; see the references doc.

#### Jito Vaults

SDK: `@jito-foundation/restaking-sdk` and `@jito-foundation/vault-sdk`. Each vault has a Vault Receipt Token (VRT) — an SPL token you receive on deposit and burn on withdraw. Withdrawals are epoch-cooldown-gated.

Docs: https://docs.restaking.jito.network/
Mint a VRT against a supported SPL deposit token → VRT accrues yield from operators serving NCNs (Node Consensus Networks).

#### Marginfi

SDK: `@mrgnlabs/marginfi-client-v2`. Marginfi treats lending as "banks" not "vaults" but the deposit semantics are identical (shares-vs-underlying via liquidity index).

```typescript
import { MarginfiClient, getConfig } from '@mrgnlabs/marginfi-client-v2';
const client = await MarginfiClient.fetch(getConfig('production'), wallet, connection);
const account = await client.createMarginfiAccount();
const usdcBank = client.getBankByTokenSymbol('USDC');
await account.deposit(100, usdcBank.address);
```

#### Meteora

- **DLMM Vaults** (`@meteora-ag/dlmm-vault`): wraps `@meteora-ag/dlmm` LP positions in a vault accounting layer.
- **Alpha Vaults** (`@meteora-ag/alpha-vault-sdk`): launchpad anti-bot vaults — depositors lock USDC during a window, get pro-rata allocation of the launching token, then vest.

Treat Meteora deposits as LP positions with impermanent loss, not lending — APY numbers blend fees and IL.

### Building your own vault

If a provider doesn't fit your strategy, fork `drift-labs/drift-vaults` — it's the cleanest open-source reference for share accounting, HWM tracking, and request-based withdrawals on Solana. It's Anchor-based, well-commented, and has a CLI + UI template (`drift-labs/vaults-ui-template`) you can adapt. Key decisions:
- Tokenize shares (SPL mint) or PDA-only? Tokenize if you want composability, PDA-only for gas.
- Fixed-period redemption (Drift-style) or epoch-based (Jito-style)?
- Manager scope: order placement only (Drift's delegate model — manager cannot withdraw funds) vs. full custody.

## Common pitfalls

1. **Confusing shares with underlying balance.** A vault that returns `vaultShares: 100000000` does NOT mean the depositor has 100 USDC. Multiply by `pricePerShare` (often stored as `totalEquity / totalShares`, sometimes a Q64.64 fixed-point number — check the program's IDL). Drift's `VaultDepositor.vaultShares` and `Vault.totalShares` are both `i128`; divide carefully.

2. **Skipping `initializeVaultDepositor` on first deposit.** The deposit ix requires the depositor PDA to exist. Drift's SDK can init atomically if you pass the `initVaultDepositor` arg, but if you forget it and the account doesn't exist, the tx will fail with `AccountNotInitialized` rather than auto-creating. Always check `getAccountInfo(vaultDepositor)` first or pass the init arg.

3. **Withdrawing during a lockup epoch.** Drift `requestWithdraw` does not pay you immediately — it queues a request that finalizes after `redeem_period`. Calling `withdraw` before the period expires fails with `WithdrawNotAvailable`. Users repeatedly try to "withdraw faster" by re-requesting; that just resets the timer in some implementations. Educate users that the timer is one-way.

4. **High-water mark gotchas.** Profit share is charged per-depositor against your HWM, not the vault's all-time high. If you deposited at $1.20/share, dropped to $1.00, and the vault is now at $1.10, the manager owes you no profit share on the recovery (it's below your HWM) — but new depositors who entered at $1.00 pay full freight on the $0.10 gain. When displaying "your net APY," always compute against the depositor's recorded HWM, never the vault-level `totalEquity / totalShares`.

5. **Vault manager rug / delegate scope confusion.** Drift's delegate model only lets the manager place orders on the vault's Drift account — they cannot withdraw user funds. But some vaults (especially homegrown ones or non-audited forks) give the manager full transfer authority. Before depositing, verify on-chain: read the vault's `delegate` field and check what instructions that key can sign in the program. If the manager keypair has any `Transfer` authority on the vault's USDC ATA, it's a rug-able design.

6. **Misreading APY displays.** Drift and Kamino UIs display APY as a **trailing 30-day annualized return**, not a guaranteed yield. A vault showing "200% APY" likely had one outlier month and is mean-reverting. Always look at the all-time return chart and the manager's risk parameters (leverage, position limits) before quoting expected returns.

7. **Using public RPCs for vault deposits.** Vault deposit txs touch 8–20 accounts and trigger a price update CPI; they exceed the compute budget on small RPCs and silently drop. Use Helius / Triton / QuickNode with `simulateTransaction` first, set `computeUnitLimit` to ~600k, and add a `setComputeUnitPrice` priority-fee ix.

8. **Reading stale account state.** Drift's `VaultClient` uses a `BulkAccountLoader` cache — if you `await deposit(...)` then immediately `await getVaultDepositor(...)`, you may read the pre-deposit snapshot. Call `await driftClient.accountSubscriber.fetch()` between writes and reads, or load with a fresh `connection.getAccountInfo` and decode manually.

## References

- `scripts/deposit-drift-vault.ts` — depositing USDC into a Drift vault, reading share balance.
- `scripts/deposit-kamino-vault.ts` — depositing USDC into Kamino main market USDC reserve.
- `references/vault-providers.md` — comparison table: strategy type, lockup, fees, SDK, TVL.

External:
- Drift Vaults docs: https://github.com/drift-labs/drift-vaults/wiki
- Drift Vaults SDK source: https://github.com/drift-labs/drift-vaults/tree/master/ts/sdk
- Kamino docs: https://docs.kamino.finance/
- Kamino klend-sdk: https://github.com/Kamino-Finance/klend-sdk
- Jito Restaking docs: https://docs.restaking.jito.network/
- Marginfi TS SDK: https://docs.marginfi.com/ts-sdk
- Meteora Alpha Vault SDK: https://github.com/MeteoraAg/alpha-vault-sdk
- Gauntlet VaultBook (curator analytics): https://vaultbook.gauntlet.xyz/
- DeFiLlama Solana TVL: https://defillama.com/chain/Solana

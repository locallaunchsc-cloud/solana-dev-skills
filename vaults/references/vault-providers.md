# Solana Vault Providers — Comparison Table

Snapshot: 2026-05-21. TVL figures from DeFiLlama; verify before quoting in production.

## Quick comparison

| Provider | Strategy type | Lockup | Fees | SDK (npm) | TVL (≈) | Share token? |
|---|---|---|---|---|---|---|
| **Drift Vaults** | Delegate-managed perp MM, basis trades, JLP hedges, insurance-fund staking | Per-vault `redeem_period` (1–7 days typical) | 0–2% mgmt + 20–30% profit share over HWM | `@drift-labs/vaults-sdk` | ~$200M | Optional SPL (tokenized shares) or PDA |
| **Kamino Lend** | Variable-rate lending across reserves (USDC, SOL, JLP, etc.) | None (instant withdraw if liquidity available); 30-day for specific lockup programs (e.g. JTO) | Reserve protocol fee on borrow interest spread (0–20% of borrow rate) | `@kamino-finance/klend-sdk` | ~$2.4B | cTokens via obligation PDA |
| **Kamino Liquidity (kvaults)** | Automated concentrated LP rebalancing on Orca/Raydium/Meteora pools | None | Performance fee 5–10% of fees earned | `@kamino-finance/kliquidity-sdk` | ~$300M (subset of Kamino TVL) | SPL share mint per vault |
| **Jito (Re)staking Vaults** | Restaking — delegated SPL tokens earn from NCN operators | Epoch-based cooldown (multi-epoch, ≈4–10 days) | Set per-vault; mgmt + reward share | `@jito-foundation/vault-sdk`, `@jito-foundation/restaking-sdk` | ~$500M | Vault Receipt Token (SPL) |
| **Marginfi (banks)** | Variable-rate lending; isolated-mode for long-tail; mrgnLST liquid staking | None for standard banks | Origination fee + interest spread (per-bank) | `@mrgnlabs/marginfi-client-v2` | ~$300M | Liquidity-index PDA (no SPL share) |
| **Meteora Alpha Vault** | Launchpad pre-sale anti-bot vault (fair-share allocation of new token) | Deposit window → purchase window → vesting (no early withdraw) | Project-set | `@meteora-ag/alpha-vault-sdk` | per-launch | SPL claim token |
| **Meteora DLMM Vault** | Concentrated LP on DLMM pools | None | LP-fee retention varies | `@meteora-ag/dlmm-vault` | ~$150M | SPL position |

## Detail notes per provider

### Drift Vaults
- Permissionless program. Anyone can spin up a vault (`initializeVault`) with custom `redeem_period`, `min_deposit_amount`, `management_fee`, `profit_share`, `hurdle_rate`.
- Delegate scope is **place/cancel orders only** on the vault's Drift account — manager cannot withdraw user funds. This is enforced in the Anchor program, not just policy.
- Curated lineup at https://app.drift.trade/vaults includes Circuit (delta-neutral MM, 30% profit share), Turbocharger (leveraged MM), hJLP (hedged JLP), Gauntlet Basis Alpha.
- Source: https://github.com/drift-labs/drift-vaults

### Kamino Lend
- Top Solana protocol by TVL in 2026.
- Three main markets: Main (`7u3H...`), JLP isolated (`DxXd...`), Altcoin (`ByYi...`). Use the right market for the asset you want exposure to.
- Lending has no lockup — you can withdraw any time the reserve has utilization headroom. If utilization is at 100%, you wait for borrowers to repay or for new supply.
- Specific programs (JTO liquidity, periodic incentives) layer 30-day locks on top — read the program docs before depositing.
- Source: https://github.com/Kamino-Finance/klend-sdk

### Kamino Liquidity (kvaults)
- Separate from Kamino Lend. Targets LPs: deposit two assets (or one with auto-swap), the strategy rebalances concentrated-liquidity positions on Orca/Raydium/Meteora.
- "Pegged" strategies (USDC/USDT, jitoSOL/SOL): tight ranges, minimal IL.
- "Stable" strategies (mSOL/SOL): medium range.
- "Volatile" strategies (SOL/USDC, JTO/SOL): wide range, real IL risk.
- Source: https://github.com/Kamino-Finance/kliquidity-sdk

### Jito (Re)staking Vaults
- Two on-chain programs: Restaking (`RestkWeAVL8fRGgzhfeoqFhsqKRchg6aa1XrcH96z4Q`) and Vault (`Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8`).
- Each vault accepts one SPL deposit token, mints a VRT, and delegates to one or more Operators serving NCNs (Node Consensus Networks).
- Withdrawal is epoch-cooldown gated to allow slashing windows. Plan multi-day exits.
- Docs: https://docs.restaking.jito.network/

### Marginfi
- Lending UX-similar to Kamino but accounting is bank-based: each asset is a "bank" with its own LTV / oracle / interest curve, and your `MarginfiAccount` can hold up to 16 banks at once.
- No SPL share token — your balance is `account.balances[i].assetShares * bank.assetShareValue`.
- Acquired by Project 0 (0.xyz) in 2026; TGE pending. SDK remains the canonical integration path.
- Docs: https://docs.marginfi.com/ts-sdk

### Meteora Alpha Vault
- Not a yield vault — a **launch primitive**. Use it when you're a project launching a token and want fair-share allocation, or when you're a depositor wanting allocation in a launching token.
- Three phases: Deposit (users deposit USDC), Purchase (vault buys the launching token at TGE price), Vesting (users claim over time).
- Anti-bot: pro-rata allocation if oversubscribed, no first-come-first-served.
- Docs: https://docs.meteora.ag/integration/alpha-vault-integration/alpha-vault-typescript-sdk

### Meteora DLMM Vault
- Layered on Meteora's Dynamic Liquidity Market Maker (DLMM). DLMM uses bin-based concentrated liquidity; the vault automates rebalancing across bins.
- APY is fee yield minus impermanent loss — treat displayed APY as an upper bound.
- Docs: https://docs.meteora.ag/

## Choosing a provider

| If you want… | Pick |
|---|---|
| Lowest-risk USDC yield, no lockup | Kamino Lend main market |
| Yield from a managed strategy, willing to wait for withdrawals | Drift Vaults (Circuit / hJLP) |
| Restaking yield, comfortable with epoch cooldowns | Jito Vaults |
| Lending across 16 isolated banks in one account | Marginfi |
| Liquid LP exposure with automated rebalancing | Kamino kvaults or Meteora DLMM vault |
| Anti-bot launch allocation | Meteora Alpha Vault |
| To run your own strategy | Fork `drift-labs/drift-vaults` |

## Caveats

- TVL changes daily. Always pull live from DeFiLlama or the provider's UI before quoting.
- "APY" on UIs is usually trailing-30-day annualized return, not forward-looking yield. Vaults with three-figure APY almost always mean-revert.
- Performance fees are charged per-depositor against a high-water mark — your effective fee depends on entry timing.
- A public SDK is not an audit. Read the program's audit history (Drift, Kamino, Jito, Marginfi all have multiple public audits; smaller forks usually don't).

# Solana Binary Prediction Market Venues — Comparison

Verified May 2026. Three venues have production traction; everything else researched (Monaco/BetDEX, Polymarket-on-Solana, Limitless) is either archived, not on Solana, or has not launched a Solana deployment.

## Side-by-side

| Dimension | Drift BET | DFlow → Kalshi | Hxro Parimutuel |
|---|---|---|---|
| **Market model** | Perp w/ price clamped to [0,1] (CLOB) | Tokenized binary outcomes (CLOB + JIT router) | Parimutuel pool, no mid-market trading |
| **Outcome representation** | Long/short perp position | Real SPL tokens (YES mint + NO mint) | Pool stake position |
| **Fee model** | Taker ~0.10%, maker rebate; funding accrues between longs/shorts | DFlow router fee ~0.10–0.30% + Kalshi spread; no funding (spot tokens) | House fee on settled pool; explicit % varies by market |
| **Collateral** | 30+ tokens accepted as collateral (cross-collateral) | USDC only (canonical Circle mint) | USDC primarily; some markets accept other tokens |
| **Leverage** | Yes — perp leverage available | No — spot positions only | No — staked size = max exposure |
| **Oracle / resolution source** | Drift keepers resolve to 0 or 1 based on documented market source (price ref, attestable event) | Kalshi (CFTC-regulated exchange) resolves the underlying; DFlow mirrors resolution onchain | Pyth price feed at expiry timestamp |
| **Market creation** | Permissioned to Drift governance (proposal flow) | Permissioned via Kalshi market-request process | Templated — anyone can deploy a new market on an existing Pyth feed |
| **Tail-asset support** | Limited — curated list of crypto / macro markets, dozens | Strongest on Solana — thousands of long-tail markets (sports, politics, weather, econ, entertainment) | Medium — any Pyth-listed asset, but only price-direction markets |
| **Settlement** | Auto-settles perp PnL; no manual claim | Manual — winning tokens must be redeemed via `/order` endpoint after `redemptionStatus: open` | Auto — payouts distributed to winning pool stakers |
| **SDK maturity** | High — `@drift-labs/sdk` (TS), `driftpy` (Py), `drift-rs` (Rust); actively maintained | Medium — no official SDK; well-documented REST API at `pond.dflow.net`; dev endpoints open with no key | Medium — `@hxronetwork/parimutuelsdk` (TS) on npm; smaller community |
| **Composability** | Position is a Drift perp position (usable as cross-collateral inside Drift) | Outcome tokens are SPL — full DeFi composability (LP, lend, transfer) | Pool stake is opaque; not composable outside Hxro |
| **Best for** | Liquid crypto / macro views with leverage; market-making | Broadest long-tail surface; building products on top of real-world events | Short-duration price-direction wagers (BTC up/down in N minutes) |
| **Known weaknesses** | Funding drag on long-dated markets; only ~dozens of markets at once | KYC required (Proof) for real-money trades; resolution speed depends on Kalshi | No mid-market exit — locked until expiry; pool dilution if late stakers crowd in |

## Pricing & sizing notes

- **Drift BET.** Oracle price equals YES probability in `PRICE_PRECISION` (1e6). For a $25 stake at p=0.62: base size = 25 / 0.62 ≈ 40.32 YES units. Long = YES, Short = NO. Use `PostOnlyParams.TRY_POST_ONLY` on tail markets to avoid eating the spread.
- **DFlow.** Quotes come back in USDC base units (6 decimals). $25 = `25_000_000`. The `/order` endpoint returns a base64 versioned tx — deserialize with `VersionedTransaction.deserialize`, sign, send via `sendRawTransaction`.
- **Hxro.** Stake amount is the entire commitment — there is no orderbook price. Payout = `(your_stake / winning_pool) * total_pool * (1 - fee)`.

## Capital flow quick reference

```
DRIFT BET
  USDC -> Drift collateral account -> open LONG/SHORT perp position
  -> on resolution, perp PnL settles to USDC in collateral account

DFLOW / KALSHI
  USDC -> /order swap -> YES or NO SPL token in your ATA
  -> on resolution, /order swap -> USDC back to your ATA

HXRO PARIMUTUEL
  USDC -> stake into LONG or SHORT pool of a contest
  -> at expiry, payout auto-distributed proportional to your stake
```

## When to pick which

- **You want leverage or to short** → Drift BET
- **You want the most markets / long-tail / sports & politics** → DFlow/Kalshi
- **You want short-duration price-up-or-down** → Hxro
- **You want SPL tokens you can LP into AMMs** → DFlow/Kalshi (only spot tokens)
- **You want to read a probability into another smart contract** → Drift BET (clean oracle account) or DFlow (token price on a DEX pool)
- **You want to launch a market on a tail asset right now without governance** → Hxro on a Pyth-listed feed (only price-direction; for arbitrary events, no Solana venue is fully permissionless as of May 2026)

## Gaps & opportunities (May 2026)

- No fully permissionless venue for **arbitrary tail-asset events** (e.g., "Will memecoin X be >$0.10 on June 30?") with on-chain oracle resolution. Kalshi covers thousands of events but is gated by their listing process.
- No mature **probability oracle** that other Solana protocols can consume to gate lending or insurance.
- Hxro's parimutuel model is the only fully permissionless market creation path but is limited to price direction on Pyth feeds and has no mid-market exit.

These gaps are what @mert flagged as "onchain binary markets, especially for tail assets" being a top Solana priority — the infrastructure exists, the breadth doesn't yet.

---
name: solana-metadao
description: Use this skill when the user wants to interact with MetaDAO on Solana — futarchy-based governance and capital formation. Read proposals, trade conditional tokens (pass/fail markets), participate in token launches, and understand the futarchy mechanism.
---

# MetaDAO — Futarchy on Solana

## Overview

**MetaDAO** is the production futarchy implementation on Solana. Futarchy — coined by economist Robin Hanson in 2000 — replaces voting with markets: proposals are decided by which **conditional token market** predicts a higher token price. "Vote values, bet beliefs." Helius CEO @mert has called it `a gem, should be 'kingmade'` and listed it as a top priority for Solana's capital formation stack.

Two pillars built on the same primitives:

1. **Decision-market governance** — Every DAO action runs through paired PASS/FAIL conditional markets. Trader-weighted prices, not votes, choose the outcome.
2. **Unruggable ICO launchpad** — Founders raise into a treasury they cannot unilaterally drain. Every spend is a futarchic proposal. As of 2026 MetaDAO has facilitated ~96 proposals across 14 organizations including Jito, Drift, Sanctum, Marinade, and Flash.

The primitive that makes this work is the **conditional vault**: deposit 1 META and mint 1 pPASS-META + 1 pFAIL-META. Both tokens trade on their own AMM. After the 3-day trading window, the **TWAP oracle** of the PASS market is compared to the FAIL market. If the PASS-quote price is at least **3% above** the FAIL-quote price (or **-3%** for team-sponsored proposals), the proposal passes — only PASS holders redeem the underlying; FAIL holders' deposits revert to spot. If it fails, vice versa.

> Why this matters for capital formation: the same vault that holds the treasury also gates every withdrawal behind a market. There is no key a founder can lose, no rug a founder can pull, no governance attack via vote buying — to bend the DAO you have to put real capital on a wrong price, and any informed trader can take the other side. See `references/futarchy-explainer.md` for the full mental model.

## When to use this skill

- "Read the latest MetaDAO proposal for X"
- "How do I trade the pass/fail market on proposal Y?"
- "Mint pPASS / pFAIL conditional tokens for the META DAO"
- "List active futarchy proposals on Solana"
- "What's the TWAP on this proposal's pass market?"
- "Launch a token / fundraise via MetaDAO's unruggable launchpad"
- "Create a proposal to spend treasury funds"

**Not for:** generic Solana governance (use Realms / SPL Governance), binary prediction markets on tail-asset events (use the `solana-binary-markets` skill — Drift BET / DFlow / Hxro), or vanilla token launches (use `solana-token-launch`).

## Prerequisites

Verified against mainnet on 2026-05-21. The official SDK was historically published as `@metadaoproject/futarchy-sdk` but **that package was archived May 2025**. The current active SDK lives in the `metaDAOproject/programs` monorepo and is published as `@metadaoproject/programs` (currently `0.1.0-alpha.2`, the canonical client for v0.5/v0.6/v0.7 programs).

```json
{
  "dependencies": {
    "@metadaoproject/programs": "0.1.0-alpha.2",
    "@coral-xyz/anchor": "0.29.0",
    "@solana/web3.js": "1.98.0",
    "@solana/spl-token": "0.4.14",
    "@noble/hashes": "1.4.0",
    "bn.js": "5.2.1"
  },
  "devDependencies": {
    "typescript": "5.6.3",
    "tsx": "4.19.2"
  }
}
```

> Anchor must be pinned to **0.29.0** — the published IDLs were generated against that version and newer Anchor will reject the discriminator layout.

### Verified mainnet program IDs (from `metaDAOproject/programs` Anchor.toml, May 2026)

| Program | Version | Address |
|---|---|---|
| **Futarchy** (DAO + proposal lifecycle) | v0.6 | `FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq` |
| **Conditional Vault** (mints pPASS/pFAIL) | v0.4 | `VLTX1ishMBbcX3rdBWGssxawAo1Q2X2qxYFYqiGodVg` |
| AMM (per-market xy=k with TWAP oracle) | v0.5 | `AMMJdEiCCa8mdugg6JPF7gFirmmxisTfDJoSNSUi5zDJ` |
| Autocrat (legacy DAO controller, v0.5 era) | v0.5 | `auToUr3CQza3D4qreT6Std2MTomfzvrEeCC5qh7ivW5` |
| **Launchpad** (current ICO program) | v0.8 | `moonDJUoHteKkGATejA5bdJVwJ6V6Dg74gyqyJTx73n` |
| Launchpad | v0.7 | `moontUzsdepotRGe5xsfip7vLPTJnVuafqdUWexVnPM` |
| Bid Wall (post-launch price support) | v0.7 | `WALL8ucBuUyL46QYxwYJjidaFYhdvxUFrgvBxPshERx` |
| Mint Governor | v0.7 | `gvnr27cVeyW3AVf3acL7VCJ5WjGAphytnsgcK1feHyH` |
| META mint (governance token) | — | `METAwkXcqyXKy1AtsSgJ8JiUHwGCafnZL38n3vYmeta` |
| USDC (quote asset on mainnet) | — | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |

All addresses are also exported from the SDK as constants — never hardcode, prefer `import { FUTARCHY_V0_6_PROGRAM_ID, META_MINT, MAINNET_USDC } from "@metadaoproject/programs"`.

### External resources

- App: https://metadao.fi (live) — legacy interface at https://v1.metadao.fi for browsing pre-v0.6 proposals
- Docs: https://docs.metadao.fi
- REST API base: `https://market-api.metadao.fi` (60 req/min — tickers, supply, aggregate volume; no per-proposal endpoint yet — on-chain reads are the source of truth)
- GitHub org: https://github.com/metaDAOproject
- Active programs repo: https://github.com/metaDAOproject/programs

## Workflow

### Concepts — the 5 accounts that matter

A live MetaDAO proposal is a **graph of 7 on-chain accounts**:

```
                    ┌─── Proposal ────┐
                    │  (futarchy)     │
                    └─────────────────┘
                       │     │     │
        ┌──────────────┘     │     └─────────────┐
        v                    v                   v
   ┌─────────┐         ┌─────────┐         ┌─────────┐
   │baseVault│         │  AMM    │         │AMM      │
   │ (META)  │         │  PASS   │         │ FAIL    │
   └─────────┘         │ (v0.5)  │         │(v0.5)   │
        │              └────┬────┘         └────┬────┘
        │                   │ TWAP oracle       │ TWAP oracle
   mints + burns            │                   │
        v                   │                   │
   pPASS-META               │                   │
   pFAIL-META               │                   │
                            │                   │
   ┌─────────┐              │                   │
   │quoteVault│             │                   │
   │ (USDC)  │              │                   │
   └─────────┘              │                   │
        │                   v                   v
   pPASS-USDC          pPASS-META/pPASS-USDC  pFAIL-META/pFAIL-USDC
   pFAIL-USDC
```

- **Vault** (`conditional_vault` v0.4): deposit 1 underlying → mint 1 pPASS + 1 pFAIL. There's one vault per (proposal, mint) pair, so a META/USDC proposal has 2 vaults and 4 conditional mints.
- **Conditional tokens**: ordered by index in the vault. **Index 0 = FAIL, Index 1 = PASS** (mint addresses derived via `getConditionalTokenMintAddr(programId, vault, index)`).
- **AMM** (`amm` v0.5): one constant-product pool per market — `pPASS-META/pPASS-USDC` and `pFAIL-META/pFAIL-USDC`. Half the spot liquidity is duplicated into each market when the proposal launches.
- **TWAP oracle**: each AMM stores an aggregator (`u128`) of `seconds × last_observation`. Prices use a **lagging cap** (`twapMaxObservationChangePerUpdate`) so flash-price manipulation cannot move the TWAP. Anyone can permissionlessly call `crank_that_twap` to update the observation.
- **Proposal account fields you'll read**:

  ```
  state               ProposalState ::= Draft { amountStaked } | Pending | Passed | Failed | Removed
  dao                 Pubkey   // parent DAO
  question            Pubkey   // conditional-vault question (proposal hash)
  baseVault           Pubkey   // META-side vault
  quoteVault          Pubkey   // USDC-side vault
  passBaseMint        Pubkey   // pPASS-META
  passQuoteMint       Pubkey   // pPASS-USDC
  failBaseMint        Pubkey   // pFAIL-META
  failQuoteMint       Pubkey   // pFAIL-USDC
  squadsProposal      Pubkey   // links to a Squads v4 tx that executes on Pass
  durationInSeconds   u32      // trading window length (typ. 3 days = 259200)
  timestampEnqueued   i64      // when proposal entered Pending
  isTeamSponsored     bool     // -> -3% threshold instead of +3%
  number              u32      // human-readable proposal number per DAO
  ```

### 1. Read an active proposal

```ts
import { FutarchyClient } from "@metadaoproject/programs/futarchy/v0.6";
import { AmmClient } from "@metadaoproject/programs/amm/v0.5";
import { AnchorProvider } from "@coral-xyz/anchor";

const provider = AnchorProvider.env();
const futarchy = FutarchyClient.createClient({ provider });
const amm = AmmClient.createClient({ provider });

const proposalKey = new PublicKey("..."); // proposal account
const proposal = await futarchy.getProposal(proposalKey);
const dao = await futarchy.getDao(proposal.dao);

// PASS AMM PDA = derived in AMM v0.5 from (passBaseMint, passQuoteMint)
const passAmmAccount = await amm.fetchAmm(passAmmPda);
const failAmmAccount = await amm.fetchAmm(failAmmPda);

// price = (reserves_quote / reserves_base) and TWAP is in oracle.aggregator
// Convert to UI price: ui = price * 10^(base_decimals - quote_decimals) / 1e12
```

See `scripts/read-proposal.ts` for the full version that resolves all 7 PDAs, prints spot vs TWAP for both markets, and computes the pass/fail margin.

### 2. Trade pass/fail conditional tokens

The motion is **always two transactions** at the protocol level (one to mint conditional tokens from underlying, one to swap on the conditional AMM) but the SDK wraps both into a single ix builder:

```ts
import { FutarchyClient } from "@metadaoproject/programs/futarchy/v0.6";
import BN from "bn.js";

await futarchy
  .conditionalSwapIx({
    dao,
    baseMint: META,      // METAwkXcqyXKy1AtsSgJ8JiUHwGCafnZL38n3vYmeta
    proposal: proposalKey,
    market: "pass",      // "pass" | "fail"
    swapType: "buy",     // "buy" = quote -> base, "sell" = base -> quote
    inputAmount: new BN(10_000_000),       // 10 USDC (6 decimals)
    minOutputAmount: new BN(0),            // SET REAL SLIPPAGE in prod
  })
  .rpc();
```

What this actually does on-chain:
1. Pulls `inputAmount` USDC from your ATA into the proposal's quote vault.
2. Mints `inputAmount` pPASS-USDC + `inputAmount` pFAIL-USDC to your ATAs.
3. Swaps pPASS-USDC → pPASS-META on the pass AMM (constant-product).
4. You now hold pPASS-META (long on "proposal passes") and pFAIL-USDC (unused fail-side balance).

To **exit** before resolution: swap pPASS-META → pPASS-USDC on the pass AMM, then redeem both pPASS-USDC and pFAIL-USDC back to USDC via `vaultClient.mergeConditionalTokens` (only works if you have equal balances of pPASS and pFAIL — otherwise wait for resolution).

To **redeem after resolution**: once `proposal.state` is `Passed` or `Failed`, the winning side's conditional tokens redeem 1:1 against the underlying via the conditional vault. The losing side's tokens are worthless.

See `scripts/trade-conditional.ts` for the full mint + swap + redeem flow.

### 3. Create a proposal

Creating a proposal involves:
1. **Draft** — call `futarchy.initializeProposalIx` with a Squads v4 transaction (the action to execute on Pass), a description URI (IPFS/Arweave), and a duration. State = `Draft { amountStaked: 0 }`.
2. **Stake** — META holders call `stakeToProposalIx` until total stake clears the DAO's `passThresholdBps` minimum (typically 200k–1.5M META depending on DAO). Staking is **anti-spam only — no slashing, no lockup**.
3. **Launch** — once threshold is met, anyone calls `launchProposalIx`. This snapshots half the spot liquidity into pass + fail AMMs, mints conditional tokens, sets state to `Pending`, and starts the `durationInSeconds` clock. The TWAP oracle then has a **24-hour delay** before recording begins (gives traders time to price).
4. **Finalize** — after `timestampEnqueued + durationInSeconds`, anyone calls `finalizeProposalIx`. The program reads both AMMs' TWAPs, applies the 3% threshold (or -3% if `isTeamSponsored`), and sets state to `Passed` or `Failed`. If `Passed`, the linked Squads transaction becomes executable.

In practice you rarely write the create-proposal flow from scratch — most users propose through the web UI at `metadao.fi`. The full programmatic example lives in the repo at `metaDAOproject/programs/scripts/v0.5/initializeProposal.ts`.

### 4. The launchpad — using MetaDAO as an ICO venue

The launchpad (program v0.8 = `moonDJUoHteKkGATejA5bdJVwJ6V6Dg74gyqyJTx73n`) is futarchy's "skin in the game" ICO model:

- Founders deposit a percentage of total supply into a futarchy DAO at launch.
- Raised USDC sits in a Squads v4 vault gated by the futarchy program. **No founder unilateral spending.** Every withdrawal is a proposal.
- The `bid_wall` program (`WALL8...`) provides a programmatic post-launch floor — uses raised USDC to buy back the token below a price.
- The `mint_governor` and `performance_package_v2` programs vest team allocations behind on-chain milestones rather than time-only cliffs.

This is the "unruggable" claim: a founder *cannot* withdraw raised funds without the market voting yes on each spend. To use it, run `scripts/v0.7/startLaunch.ts` from the programs repo, or use the `metadao.fi` UI which calls into the same programs.

## Common pitfalls

1. **pPASS vs pFAIL index confusion** — In the conditional vault, **index 0 is FAIL and index 1 is PASS**. The SDK exposes both `getDownAndUpMintAddrs` (down=fail, up=pass) and `getFailAndPassMintAddrs`. Mixing them up means you end up long the side you wanted to short. Always derive via the named helper and never assume an order.

2. **Mint-before-trade requirement** — You cannot buy pPASS-META directly. You must first deposit underlying META into the vault to mint pPASS + pFAIL pairs, *then* swap pFAIL away on the fail AMM. The `conditionalSwapIx` helper hides this, but if you call the AMM swap instruction directly with USDC, it will fail because the AMM only accepts the *conditional* mint, not USDC.

3. **TWAP timing — 24 hour delay before recording** — The DAO field `twapStartDelaySeconds` (typ. 86400 = 24 hours) is the gap between when a proposal goes Pending and when the TWAP oracle begins observing. For the first day after a proposal launches, the spot AMM price is moving but the TWAP isn't recording yet. Don't write resolution logic that assumes the TWAP started at `timestampEnqueued` — it starts at `timestampEnqueued + dao.twapStartDelaySeconds`.

4. **Oracle finalization lags the UI** — `proposal.state` only flips to `Passed`/`Failed` when someone *sends* `finalizeProposalIx`. The web UI sometimes shows "resolved" based on its own off-chain TWAP calculation **minutes before** the on-chain state changes. If you're indexing or auto-redeeming, read the on-chain `state` field; do not trust the UI badge. Anyone can permissionlessly send the finalize ix — if it's been more than `durationInSeconds` and the state is still `Pending`, just send it yourself.

5. **TWAP-aware redemption requires `crankThatTwap`** — Between observation updates, the on-chain TWAP can be stale by minutes. Before reading the TWAP for any high-value decision, call `ammClient.crankThatTwap(amm)` (permissionless, ~2k CU) to force an observation update. The protocol uses lagging caps (`twapMaxObservationChangePerUpdate`) so even a stale TWAP can't be manipulated, but reading it without cranking gives you yesterday's number for new proposals.

6. **Thin tail-proposal liquidity** — Large DAOs (META, Drift) have deep pass/fail markets. Newer / smaller DAO proposals can have <$10k in each conditional AMM. Slippage on a $1k swap can be 10%+, and a single whale on either side can move the TWAP enough to flip the 3% threshold. Always check `passAmm.totalLiquidity` and `failAmm.totalLiquidity` before sizing — if either is below ~$50k equivalent, treat the market as unreliable for governance signal.

7. **Quote-token symmetry assumption** — Pass and Fail markets quote in *different* conditional USDCs (pPASS-USDC and pFAIL-USDC). You cannot arb pass-USDC against fail-USDC directly — they're separate mints. Arbitrage happens only by minting balanced PASS+FAIL conditional pairs from underlying USDC, which forces convergence (since 1 pPASS-USDC + 1 pFAIL-USDC always redeems to 1 USDC after resolution).

8. **Squads multisig coupling** — Every MetaDAO DAO is a Squads v4 multisig under the hood (`SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`). A proposal that passes executes a *Squads* transaction. If you're creating proposals programmatically you must derive the Squads transaction PDA *before* calling `initializeProposalIx` and pass it in — getting the `transactionIndex` wrong silently produces a proposal that, if it passes, will fail to execute. The script at `metaDAOproject/programs/scripts/v0.5/initializeProposal.ts` shows the correct derivation.

## References

- App (current): https://metadao.fi
- App (legacy / pre-v0.6): https://v1.metadao.fi
- Docs: https://docs.metadao.fi
- Program architecture: https://docs.metadao.fi/implementation/program-architecture
- Programs monorepo (SDK + Anchor programs): https://github.com/metaDAOproject/programs
- npm SDK: https://www.npmjs.com/package/@metadaoproject/programs
- REST API docs: https://api-docs.metadao.fi (base: `https://market-api.metadao.fi`)
- Transparency dashboard: https://metadao.fi/transparency
- Helius primer on futarchy + governance: https://www.helius.dev/blog/futarchy-and-governance-prediction-markets-meet-daos-on-solana
- Blockworks futarchy explainer: https://blockworks.com/news/understanding-futarchy-on-solana
- Solana Compass project page: https://solanacompass.com/projects/metadao
- Mert (@0xMert_) on MetaDAO as a Solana priority: https://x.com/0xMert_
- Robin Hanson's original 2000 paper: https://mason.gmu.edu/~rhanson/futarchy.html
- Futarchy explainer (this skill): `references/futarchy-explainer.md`

## Example scripts

- `scripts/read-proposal.ts` — connect, fetch a known proposal + DAO, derive all PDAs, print state / pPASS price / pFAIL price / TWAPs / time remaining / current pass margin.
- `scripts/trade-conditional.ts` — mint conditional tokens from underlying, swap on pass/fail AMM, and the redeem/merge path.

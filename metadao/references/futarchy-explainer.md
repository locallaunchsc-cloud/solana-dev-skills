# Futarchy — A Dev-Friendly Explainer

## The one-sentence pitch

**Vote on values, bet on beliefs.** Replace "1 token = 1 vote" governance with two paired markets — "what's the token worth if this proposal passes?" vs "if it fails?" — and let the price difference make the decision.

Coined by economist Robin Hanson in 2000 ([*Shall We Vote on Values, But Bet on Beliefs?*](https://mason.gmu.edu/~rhanson/futarchy.html)), futarchy is the on-chain answer to a stubborn problem in DAO governance: **voters know their preferences but not their consequences.** Markets, by contrast, are pretty good at pricing consequences — that's their job.

## Why it's interesting for capital formation

Traditional DAO governance has three failure modes that futarchy fixes:

| Failure | Why it happens | How futarchy fixes it |
|---|---|---|
| **Voter apathy** | Voting has no skin in the game; rational small holders don't bother | Traders only show up when there's money to be made; informed actors are *paid* to participate |
| **Vote buying / governance attacks** | Cheap to rent tokens just before a vote | To move the outcome you must put real capital on a price the rest of the market disagrees with — and lose it if you're wrong |
| **"Token holders" ≠ "informed actors"** | The biggest bag isn't always the smartest analysis | Anyone with capital + a view can trade. The DAO listens to whoever's willing to back their belief with money |

This is why Mert Mumtaz (Helius CEO) flagged MetaDAO as a "gem" in his list of Solana priorities for capital formation: an *unruggable* treasury is one where no single key — not even the founder's — can move funds. Every spend has to clear a market. Founders raise money but cannot rug it. Investors get a structural protection that vesting schedules and timelocks alone can't provide.

## The core mechanism

Imagine a DAO holds a treasury of META + USDC, and someone proposes "spend 100k USDC to acquire SmallCo."

```
                  ┌─────────────────────────────────┐
                  │  Question: should this pass?    │
                  └─────────────────────────────────┘
                              │
            ┌─────────────────┼──────────────────┐
            v                 v                  v
       PASS market       FAIL market         Threshold
       (TWAP price       (TWAP price         (e.g. PASS must be
       of META in        of META in          ≥3% above FAIL
       "passes" world)   "fails" world)      to enact)
```

For a 3-day trading window:

1. **Mint conditional tokens.** Deposit 1 META into the proposal's conditional vault. Get back 1 `pPASS-META` + 1 `pFAIL-META`. Same for USDC: 1 USDC → 1 `pPASS-USDC` + 1 `pFAIL-USDC`. The four conditional mints (`pPASS-META`, `pPASS-USDC`, `pFAIL-META`, `pFAIL-USDC`) are real SPL tokens.

2. **Trade.** Two independent AMMs spin up:
   - `pPASS-META / pPASS-USDC` — prices META "if the proposal passes"
   - `pFAIL-META / pFAIL-USDC` — prices META "if the proposal fails"
   Traders who think the acquisition is *accretive* buy pPASS-META (price goes up). Traders who think it's *value-destructive* sell pFAIL-META (or buy pPASS-USDC, equivalently). Each side moves its own AMM's price.

3. **Resolve.** After 3 days, the protocol reads the **time-weighted average price** of each AMM. If the PASS market's TWAP is ≥3% above the FAIL market's TWAP (or ≥-3% for team-sponsored proposals), the proposal passes — meaning the market *predicted higher token value with the change*. Only PASS-side conditional tokens redeem 1:1 against the underlying; FAIL-side tokens are worthless. Vice versa if it fails.

4. **Arbitrage closes the loop.** Because `1 pPASS-X + 1 pFAIL-X → 1 X` (and the reverse mint), any traded mispricing is bounded by free conversion. The price you observe is the market's best aggregated estimate of conditional value.

## A worked example

Suppose META trades at $100 spot. The DAO is asked to vote on Proposal #42 ("Hire Alice as CFO for 10k META").

Traders form views:
- Bull on Alice: "META will be worth $115 if she joins" → buy pPASS-META.
- Bear on Alice: "META will be worth $95" → buy pFAIL-META (or sell pPASS-META).

After 3 days the TWAPs settle at:

- pPASS-META TWAP: **$112**
- pFAIL-META TWAP: **$96**

Margin: (112 − 96) / 96 = **+16.7%**, well above the 3% threshold. **Proposal passes.** The 10k META gets transferred to Alice's wallet via the linked Squads transaction.

Holders of pPASS-META redeem at $112-worth of real META (they bought low, redeemed at the resolved spot). Holders of pFAIL-META get nothing — they bet wrong.

Note the elegance: nobody had to vote. The DAO simply listened to which world the market thought was worth more.

## Why TWAP and not spot price?

Spot price is trivially manipulable: flash-buy pPASS-META for one block, take a snapshot at the bottom of the candle, win. MetaDAO uses **time-weighted average price** with two extra defenses:

1. **`twapMaxObservationChangePerUpdate`** — a lagging cap on how fast the recorded observation can move per update. The protocol team recommends ~2% of spot per update; observations update once a minute, so even a $1M buy that pins the spot at +50% can only nudge the recorded TWAP by 2% per minute — taking ~25 minutes to fully reflect, plenty of time for arbitrageurs to mint balanced pairs and trade against the manipulation.
2. **24-hour delay before recording starts** — `dao.twapStartDelaySeconds` (typically 86400) gates when the TWAP oracle begins observing, giving the AMM time to find its level before the resolution clock starts.

Combined, this makes the on-chain TWAP a *very* expensive price to spoof — you'd have to sustain a manipulated price across the entire 2-day recording window against arbitrageurs who can mint balanced pairs and pick off mispricings.

## What this looks like on Solana, specifically

MetaDAO's implementation uses six core programs (mainnet, May 2026):

- **Futarchy** (`FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq`) — DAO + proposal lifecycle.
- **Conditional Vault** (`VLTX1ishMBbcX3rdBWGssxawAo1Q2X2qxYFYqiGodVg`) — splits underlying into pPASS + pFAIL SPL mints.
- **AMM** (`AMMJdEiCCa8mdugg6JPF7gFirmmxisTfDJoSNSUi5zDJ`) — constant-product market per (pass-base, pass-quote) and (fail-base, fail-quote) pair, with on-chain TWAP oracle.
- **Launchpad** v0.8 (`moonDJUoHteKkGATejA5bdJVwJ6V6Dg74gyqyJTx73n`) — ICO with the same futarchic vault on the treasury.
- **Bid Wall** (`WALL8ucBuUyL46QYxwYJjidaFYhdvxUFrgvBxPshERx`) — programmatic price floor post-launch.
- **Squads v4** (`SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`) — the multisig that *executes* a passed proposal's payload.

Solana is well-suited for this:
- **~400 ms slots** mean a 3-day trading window has ~648,000 observation opportunities — TWAPs resolve very smoothly.
- **Sub-cent fees** make the mint/swap/merge round-trip economically viable for retail traders. On Ethereum the gas cost would dominate the trade for proposals under ~$100k of liquidity.
- **Composability** — pPASS and pFAIL are normal SPL tokens, so anyone can build secondary markets, automated trading bots, or even *conditional* lending (borrow against your pPASS-META).

## When futarchy works — and when it doesn't

**Works well:**
- DAO treasury decisions where outcomes plausibly affect token price (hires, acquisitions, treasury allocations, fee changes).
- Parameter tuning where there's a measurable token-price-sensitive metric.
- Capital-formation / ICO contexts where investors need rug protection more than they need voting.

**Works poorly:**
- Decisions that don't affect price (e.g., "should we use Discord or Slack?" — no signal).
- Very small DAOs where conditional market liquidity is too thin to give a reliable TWAP.
- Proposals with externalities the token-price-maximizing market would happily ignore (e.g., "is this proposal ethical?" — the market doesn't have an opinion on ethics, only on EV).

## Further reading

- Robin Hanson, 2000: [*Shall We Vote on Values, But Bet on Beliefs?*](https://mason.gmu.edu/~rhanson/futarchy.html) — the original paper.
- Helius primer: [*Futarchy and Governance: Prediction Markets Meet DAOs on Solana*](https://www.helius.dev/blog/futarchy-and-governance-prediction-markets-meet-daos-on-solana)
- Blockworks: [*Understanding futarchy on Solana*](https://blockworks.com/news/understanding-futarchy-on-solana)
- MetaDAO docs — Decision Markets: https://docs.metadao.fi/governance/overview
- MetaDAO docs — TWAP resolution: https://docs.metadao.fi/governance/twaps
- Programs repo (audited Anchor source): https://github.com/metaDAOproject/programs

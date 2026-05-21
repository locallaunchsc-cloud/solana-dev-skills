# Solana Bridge Comparison

A side-by-side reference for the major bridges to/from Solana as of May 2026. Pick the row that matches your use case, not the one with the cheapest sticker price — the right tradeoff is usually trust model and finality, not basis points.

## Quick comparison

| Bridge | Architecture | Fee model | EVM→SOL finality | SOL→EVM finality | Supported assets | Security model | Best use case |
|---|---|---|---|---|---|---|---|
| **Circle CCTP v2** | Burn-and-mint (native USDC) | Fast lane: ~$0.10–$1 protocol fee + gas; Slow lane: gas only | ~20 sec (fast), ~13 min (slow) | ~20 sec | **USDC only** | Circle's IRIS attestation service (centralized but trusted to mint USDC anyway) | Any USDC transfer — default choice |
| **Mayan Swift v2** | Intent / solver | 0.05–0.30% spread (no fixed fee on Swift) | **~12 sec** | ~30 sec | All major ERC-20s, SOL, SPL tokens | Wormhole VAA backstop + solver collateral | Fastest EVM→Solana for arbitrary tokens, especially with gasDrop for fresh wallets |
| **deBridge DLN** | Intent / solver | Solver spread + small protocol fix fee | ~30 sec – 2 min | ~30 sec – 2 min | 100+ tokens across 26+ chains | Validator multisig (deBridge validators) + solver collateral; orders are cancellable | API-first / agent / server workflows; programmatic cross-chain orders |
| **Across (Solana)** | Intent / solver (optimistic) | 0.04–0.25% relayer fee | ~2 sec – 1 min | ~30 sec | USDC + select ETH/WETH routes | UMA optimistic oracle (challenge window) + relayer bond | USDC bridge to/from major L2s, fastest UX on supported routes |
| **Wormhole NTT** | Lock-and-release (native token transfers, no wrapped variant) | Gas only on each chain | ~3–15 min (configurable) | ~3 min | Tokens whose issuer has deployed NTT | 19-of-19 Guardian network signatures | Token issuer bridging their *own* token while keeping it canonical |
| **Wormhole Portal / WTT** | Lock-and-mint (wrapped) | Gas + optional relayer tip | ~15 min | ~3 min | Most major tokens, with wrapped representations | 19-of-19 Guardian network signatures | Long-tail tokens that don't have NTT; legacy paths |
| **Allbridge Core** | Liquidity network | Pool fee 0.1–0.3% + slippage | ~3 min | ~3 min | Stablecoins (USDC, USDT) | Multi-validator consensus + per-pool TVL exposure | Native stable-to-stable across less-common pairs (e.g. SOL ↔ Tron USDT) |

## Detail by bridge

### Circle CCTP v2

- **Trust model:** You trust Circle. Same trust assumption as holding USDC in the first place, so this is the lowest *marginal* trust bridge for USDC.
- **What gets delivered on Solana:** Native USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`). Not a wrapped variant.
- **Solana programs:**
  - `TokenMessengerMinter` — burns/mints USDC
  - `MessageTransmitter` — handles cross-chain message attestation
- **Watch out for:** CCTP v1 is being phased out starting July 31, 2026. Migrate to v2 now if you have legacy integration code. Solana support shipped October 2025, so older docs may not mention it.
- **When NOT to use:** You're bridging anything other than USDC, or you need sub-10-second settlement (CCTP fast lane is ~20s).

### Mayan Swift v2

- **Trust model:** Solvers front your destination tokens and assume source-chain reorg risk. Wormhole acts as a final-settlement backstop so a malicious solver can't steal funds even if they tried.
- **What gets delivered on Solana:** Native SPL token (correct mint — Mayan routes to the canonical token, not a wrapped variant, as long as one exists).
- **Killer feature:** `gasDrop` — you can request that the solver ship ~0.005 SOL to the destination wallet alongside the bridged token, so fresh wallets can immediately transact. No other intent bridge does this as cleanly.
- **Watch out for:** Swift v1 is deprecated; integrators must be on SDK ≥10.x and Swift v2. Quotes are short-lived (~60s); re-quote before signing if the user pauses.
- **When NOT to use:** Source chain is not EVM/Solana/Sui (no support yet for Cosmos, Aptos, etc.); or you need a refund path with explicit cancel authority (use deBridge instead).

### deBridge DLN

- **Trust model:** Solvers + a deBridge validator multisig that enforces order semantics. Orders are explicit — you have a `srcChainOrderAuthorityAddress` that can patch/cancel an unfilled order, which is rare among intent bridges and useful for server-side bots.
- **What gets delivered on Solana:** Native SPL token.
- **Killer feature:** Pure HTTP API. You don't need their SDK — `GET /v1.0/dln/order/create-tx` returns a ready-to-sign tx blob. This is the right choice for Python/Go/Rust backends, AI agents, or anywhere you don't want a JS dependency.
- **Watch out for:** Uses non-standard internal chain IDs (Solana = 7565164, not 101). Hardcoding standard chainIds is the #1 integration bug. Order can sit unfilled if your `dstChainTokenOutAmount` is too aggressive; default to `'auto'`.
- **When NOT to use:** Sub-15-second settlement requirement (Mayan Swift is faster on EVM→Solana).

### Across (Solana)

- **Trust model:** UMA optimistic oracle. Relayers post a bond and are challenged via UMA's dispute window if they misbehave. Trust assumption is "UMA tokenholders correctly resolve disputes."
- **What gets delivered on Solana:** Native USDC for USDC routes.
- **Killer feature:** Fastest mainstream UX — supported routes settle in seconds because relayers don't wait for source finality.
- **Watch out for:** Asset/route support is narrower than Mayan or deBridge — primarily USDC and a few ETH paths. Check the Across Swap API for current routes before architecting around it.

### Wormhole NTT / Portal (WTT)

- **Trust model:** 19-of-19 Guardian network. Has the longest battle-tested record on Solana but also a 2022 exploit history (now extensively re-audited and re-architected).
- **NTT vs WTT:** NTT keeps your token canonical across chains (no wrapped variants). WTT mints `tokenname.wh` on each destination chain.
- **What gets delivered on Solana (WTT):** A wrapped SPL token at a deterministic mint, often confused for native USDC/USDT but is NOT the same — Jupiter and most DEXes route differently for wrapped vs native variants.
- **Watch out for:** Manual `redeemOnSolana` may be required if the automatic relayer is delayed. Large transfers can hit `outboundLimit` rate limits on NTT integrations.
- **When to use:** You issue your own token and want one canonical representation everywhere — NTT is purpose-built for this. Or you're bridging a long-tail asset that doesn't have an intent-bridge route.

### Allbridge Core

- **Trust model:** Multi-validator consensus + AMM pool exposure. Liquidity depth in each pool is the practical security limit — a large bridge through a thin pool gives you slippage rather than a hack.
- **What gets delivered on Solana:** Native stablecoin (USDC or USDT).
- **When to use:** Niche stable pairs (e.g. Tron USDT → Solana USDC) where intent bridges don't have a solver liquidity.

## Failure modes summary

| Bridge type | Most common failure | Recovery |
|---|---|---|
| Burn-and-mint (CCTP) | Attestation never finalizes (rare) | Wait for IRIS; if >1hr, contact Circle |
| Intent / solver (Mayan, deBridge, Across) | No solver picks up the order in TTL | Order cancels and refunds to source authority |
| Lock-and-mint (Wormhole WTT) | Auto-relayer fails to redeem | Call `redeemOnSolana` manually with the VAA |
| Liquidity (Allbridge) | Slippage exceeds tolerance | Tx reverts; funds remain on source |
| NTT | Outbound rate limit hit | Wait for limit to refill (configurable per integration) |

## Decision flowchart

```
Is the asset USDC?
├── Yes -> Use Circle CCTP v2 (lowest trust, native USDC delivered)
└── No
    ├── Is speed the #1 priority (sub-30s)?
    │   ├── Yes -> Mayan Swift v2 (EVM->Solana) or Across (USDC on supported L2s)
    │   └── No
    │       ├── Is this a token I issue and want canonical everywhere?
    │       │   ├── Yes -> Wormhole NTT
    │       │   └── No
    │       │       ├── API-first / no JS SDK -> deBridge DLN
    │       │       ├── Long-tail asset -> Wormhole WTT (Portal)
    │       │       └── Native stable pair -> Allbridge Core
```

## Recommended primary + fallback pairings

Always have a fallback bridge configured. Solver bridges in particular can have temporary liquidity outages.

- **USDC EVM→Solana:** CCTP (primary) → Mayan Swift (fallback for speed-critical) → deBridge DLN (fallback for liquidity)
- **Arbitrary token EVM→Solana:** Mayan Swift (primary) → deBridge DLN (fallback) → Wormhole WTT (last resort, slow but reliable)
- **SOL→ETH:** Mayan Swift or deBridge DLN (both ~30s); avoid WTT for SOL routes unless you must
- **USDT EVM↔SOL:** deBridge DLN (primary) → Allbridge Core (fallback)

## Reference links

- Circle CCTP: https://developers.circle.com/cctp
- Mayan SDK: https://github.com/mayan-finance/swap-sdk
- Mayan docs: https://docs.mayan.finance/
- deBridge API: https://dln.debridge.finance/v1.0 (Swagger)
- deBridge docs: https://docs.debridge.com/
- Across docs: https://docs.across.to/
- Wormhole TS SDK: https://github.com/wormhole-foundation/wormhole-sdk-ts
- Wormhole NTT: https://wormhole.com/docs/products/token-transfers/native-token-transfers/
- Allbridge Core SDK: https://github.com/allbridge-io/allbridge-core-js-sdk

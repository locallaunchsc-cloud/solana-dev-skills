---
name: solana-bridges
description: Use this skill when the user wants to bridge assets to or from Solana — covering Wormhole, deBridge, Mayan Swap, Allbridge, and Circle CCTP. Includes fee comparison, time-to-finality, slippage handling, and failure recovery.
---

# Solana Bridges

## Overview

Cross-chain liquidity is the single biggest piece of friction on Solana today. Mert Mumtaz (Helius CEO) put "making bridges more robust" in his top-5 priority list for the ecosystem, and for good reason — most "Solana is down" reports from end users are really "the bridge I used got stuck." If you are building anything that touches another chain (a wallet, an exchange, a payments app, an agent that moves funds), bridging is the layer most likely to fail and the layer that determines whether users come back.

The Solana bridge landscape in May 2026 sorts into three architectural buckets, and you pick a bridge based on which bucket fits your use case:

**1. Lock-and-mint / burn-and-mint (canonical bridges)**
The source chain locks (or burns) the asset and the destination chain mints a representation (or releases the canonical asset). Slow but conceptually clean.
- **Wormhole Portal / Wrapped Token Transfers (WTT)** — the original Solana bridge; produces `*.wh` wrapped tokens on the destination. Now the canonical pathway for non-stablecoin assets thanks to Sunrise (Nov 2025 launch with MON, expanding through 2026).
- **Wormhole NTT (Native Token Transfers)** — newer framework that lets a token issuer keep one canonical token across chains rather than minting wrapped variants. Use this when you control the token contract.
- **Circle CCTP v2** — burn-and-mint for *native* USDC only. Solana support shipped October 2025. CCTP v1 deprecates July 31, 2026 — migrate now if you have v1 code.

**2. Liquidity-network bridges**
Liquidity pools on each chain; a swap on the source pool plus a withdrawal on the destination pool. Fast but priced like an AMM (slippage, fee tier).
- **Allbridge Core** — stablecoin-focused liquidity network. Best for native stable-to-stable across Solana, EVM, Tron, Avalanche.

**3. Intent-based / solver bridges**
User signs an intent ("I want X on chain B for Y on chain A"); a solver fronts the destination funds and is repaid on the source. Fastest user experience because the solver doesn't wait for source finality, they take that risk.
- **Mayan Swift v2** — fastest EVM→Solana option in 2026, typically settles in under 12 seconds. Swift v1 is being deprecated; integrators must be on v2.
- **deBridge DLN** — solver network across 26+ chains; explicit order semantics with cancel/patch authorities. Strong for programmatic / agent-driven flows because the API gives you a tx blob you sign and broadcast.
- **Across (Solana)** — intent-based, optimistic verification via UMA. Solana support shipped 2025; settles in seconds for USDC routes between Ethereum, Arbitrum, OP, Base, BNB and Solana.

**Rough decision matrix:**

| If you want… | Use |
|---|---|
| Native USDC, lowest trust assumption | Circle CCTP v2 |
| Fastest EVM→Solana for arbitrary tokens | Mayan Swift |
| Programmatic / API-first cross-chain orders | deBridge DLN |
| Bridge a token *you issue* and keep it canonical | Wormhole NTT |
| Stablecoin route that doesn't depend on a single solver | Allbridge Core |
| You're a wallet/integrator and just want one drop-in UI | Wormhole Connect |

## When to use this skill

Trigger this skill when the user says any of:
- "Bridge USDC / SOL / [token] from Ethereum/Arbitrum/Base to Solana" (or the reverse)
- "Integrate Wormhole / deBridge / Mayan / CCTP / Allbridge"
- "Why is my bridge transaction stuck?"
- "What's the cheapest / fastest way to move funds to Solana?"
- "Compare bridges for my app"
- Agent / bot use cases that need cross-chain settlement

Do **not** use this skill for same-chain swaps on Solana — that is the `jupiter-swap` skill.

## Prerequisites

- **Node 20+** (all SDKs target modern Node)
- `@solana/web3.js` v1.95+ (or the new modular v2 packages) for Solana signing and RPC
- `ethers` v6 *or* `viem` v2 for the EVM source chain — pick one and stay consistent
- An RPC for each chain you touch:
  - Solana: Helius / Triton / QuickNode — **never** rely on the public `api.mainnet-beta.solana.com` for bridge claim steps, it rate-limits aggressively
  - EVM: Alchemy / Infura / your own
- USDC mint addresses memorized or imported from a constants file:
  - Solana: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
  - Ethereum: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
  - Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
  - Arbitrum: `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`

Install for the two providers in this skill:
```bash
npm i @mayanfinance/swap-sdk @solana/web3.js ethers
# deBridge uses HTTP API directly — no SDK install needed
npm i node-fetch  # if on Node <22 without global fetch
```

## Workflow

### Core concepts

**Lock-and-mint vs liquidity-network vs intent-based** — these three architectures have *very different failure modes*:

- Lock-and-mint can leave funds "stuck" on the destination needing a manual `redeem`/`claim`. If you forget this step, the user thinks the bridge ate their money. Always surface the claim step in your UI or auto-claim it server-side.
- Liquidity networks fail by **slippage** — if the destination pool is thin or someone front-runs you, your minimum-out reverts and your source funds either come back or sit in escrow. Always set a sane `slippageBps` and have a refund path.
- Intent-based bridges fail by **no solver picking up the order**. Quotes have TTLs; if the price moves the solver walks away. Re-quote and retry, or have a fallback bridge.

**The universal flow:**

1. **Quote** — call the bridge for an expected output amount, route, fee, and ETA. Quotes are typically valid 30–120 seconds.
2. **Approve** (EVM source only) — ERC-20 approve to the bridge router. Many SDKs use EIP-2612 `permit` so you sign a message instead of a separate on-chain tx; prefer permit when supported.
3. **Bridge** — submit the source-chain tx. Save the tx hash *and* the bridge order ID immediately. Do not rely on the tx hash alone — most bridges have an internal order ID that is the only stable handle through finality.
4. **Wait** — poll the bridge's status API. Don't poll the source RPC and assume "confirmed source ⇒ done"; that is wrong for every bridge in this skill. Each bridge has a status endpoint that tells you whether the destination side is settled.
5. **Claim** — required for lock-and-mint (Wormhole WTT) and sometimes CCTP. Liquidity and intent bridges typically auto-deliver but you should still verify destination receipt before marking the order complete.

**Finality times (May 2026, realistic):**

| Bridge | EVM→Solana | Solana→EVM | Notes |
|---|---|---|---|
| Mayan Swift v2 | ~12 sec | ~30 sec | Solver-funded; can take longer if no solver bids |
| deBridge DLN | ~30 sec – 2 min | ~30 sec – 2 min | Solver-funded |
| Across | ~2 sec – 1 min | ~30 sec | Limited routes (mostly USDC) |
| CCTP v2 fast | ~20 sec | ~20 sec | Fast lane has a small fee; slow lane is free but ~13 min on EVM |
| Wormhole WTT | ~15 min | ~3 min | Manual relay; longer if you wait for "finalized" on Ethereum |
| Wormhole NTT | ~3–15 min | ~3 min | Configurable threshold per integration |
| Allbridge Core | ~3 min | ~3 min | Stablecoin pool dependent |

**USDC vs wrapped tokens** — this is the single biggest user-facing footgun. On Solana you may see:
- `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` — **native USDC** (Circle, what you almost always want)
- `A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM` — **USDCet** (Wormhole-wrapped USDC from Ethereum, legacy)
- `Bn113WT6rbdgwrm12UJtnmNqGqZjY4it2WoUQuQopFVn` — **USDCpo** (Wormhole-wrapped USDC from Polygon, legacy)
- `Mybi...` — countless other wrapped variants from older bridges

A user who bridges via Wormhole WTT pre-CCTP ends up with `USDCet`, *not* the native USDC their wallet/exchange/DEX expects. CCTP gives them real `EPjFW...`. If you build a wallet UI, label these as completely different tokens (because they are) or surface a "convert to native USDC" step.

**CCTP for native USDC** — for any USDC movement, default to CCTP unless you have a reason not to. The user gets the real Circle USDC, not a wrapped IOU, and the trust assumption is "Circle's attestation service" — which they already trust to mint the USDC in the first place. No new bridge risk.

---

### Per-provider walkthrough

#### Provider 1 — Mayan Swap (intent-based, fastest EVM→Solana)

Use Mayan when the user is moving any token (not just USDC) from an EVM chain to Solana and speed matters more than absolute lowest fee. Mayan's "Swift" route uses a solver network — a solver fronts SOL/SPL on Solana the moment your EVM tx confirms, and gets repaid on Ethereum later. From the user's perspective it feels like ~12 seconds.

**Flow:**

```ts
import { fetchQuote, swapFromEvm } from '@mayanfinance/swap-sdk';
import { Wallet, JsonRpcProvider } from 'ethers';

// 1. Quote
const quotes = await fetchQuote({
  amount: 100,                                  // human units, not wei
  fromChain: 'ethereum',                        // ChainName literal
  fromToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // Ethereum USDC
  toChain: 'solana',
  toToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // Solana USDC
  slippageBps: 'auto',
});
const quote = quotes[0]; // Mayan returns multiple route options, [0] is cheapest

// 2. Approve / permit (handled inside swapFromEvm via permit if supported,
//    else you must call ERC-20 approve to addresses.MAYAN_FORWARDER_CONTRACT first)

// 3. Bridge
const provider = new JsonRpcProvider(process.env.EVM_RPC_URL);
const signer = new Wallet(process.env.EVM_PRIVATE_KEY!, provider);
const result = await swapFromEvm(
  quote,
  await signer.getAddress(),
  destSolanaAddress,
  null,        // referrer
  signer,
  undefined,   // permit object — passed when permit was signed off-chain
  null,
  null,
);
const txHash = (result as any).hash;

// 4. Wait — poll Mayan explorer API
//    https://explorer-api.mayan.finance/v3/swap/trx/{txHash}
//    Status fields: clientStatus, status — wait for 'COMPLETED'
```

See `scripts/bridge-via-mayan.ts` for a full runnable example with polling.

#### Provider 2 — deBridge DLN (intent-based, programmatic / API-first)

Use deBridge when you need an HTTP API rather than an SDK — perfect for agents, server-side workflows, or non-JS languages. The flow is "build a tx by calling our API, sign it with whatever wallet you have, broadcast." deBridge's solver network ("takers") fills orders on the destination side.

**Internal chain IDs (these are NOT standard EVM chain IDs):**

| Chain | deBridge chainId |
|---|---|
| Ethereum | 1 |
| BSC | 56 |
| Polygon | 137 |
| Optimism | 10 |
| Arbitrum | 42161 |
| Avalanche | 43114 |
| Base | 8453 |
| Linea | 59144 |
| **Solana** | **7565164** |

**Flow:**

```ts
// 1. Quote + build tx in one call
const url = new URL('https://dln.debridge.finance/v1.0/dln/order/create-tx');
url.searchParams.set('srcChainId', '1');
url.searchParams.set('srcChainTokenIn', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
url.searchParams.set('srcChainTokenInAmount', '100000000');             // 100 USDC, 6 decimals
url.searchParams.set('dstChainId', '7565164');                          // Solana
url.searchParams.set('dstChainTokenOut', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
url.searchParams.set('dstChainTokenOutAmount', 'auto');                  // let solver price it
url.searchParams.set('dstChainTokenOutRecipient', solanaWallet);
url.searchParams.set('srcChainOrderAuthorityAddress', evmWallet);        // can cancel/patch order
url.searchParams.set('dstChainOrderAuthorityAddress', solanaWallet);
const { tx, estimation, orderId } = await (await fetch(url)).json();

// 2. Approve (ERC-20 approve to tx.to before broadcasting)
// 3. Broadcast tx.data / tx.to / tx.value with your signer

// 4. Poll order status:
//    https://dln-api.debridge.finance/v1.0/dln/order/{orderId}
//    status flows: Created → Fulfilled → ClaimedUnlock
```

See `scripts/bridge-via-debridge.ts` for a full example.

#### Provider 3 — Circle CCTP v2 (canonical USDC)

Default choice for any USDC movement. Burns USDC on the source chain via `depositForBurn`, Circle's IRIS service attests, and you mint on Solana via the `TokenMessengerMinter` program. No third-party bridge trust.

```ts
// EVM source: call depositForBurn on the TokenMessenger contract
// Solana destination: PDAs derived from the message, call receiveMessage on MessageTransmitter

// IRIS attestation (poll after the source tx is mined):
const attestationUrl =
  `https://iris-api.circle.com/v2/messages/${sourceDomain}?transactionHash=${txHash}`;
```

The full CCTP flow is *more* code than the intent-based bridges because you handle four explicit steps (approve, burn, attest, mint). Use `@coral-xyz/anchor` + `@solana/web3.js` for the Solana side. Circle publishes a reference repo at `circlefin/solana-cctp-contracts`. If you want a simpler API surface, Wormhole's CCTP route wraps these steps in their SDK.

## Common pitfalls

1. **Wrong wrapped variant on destination.** You bridge USDC from Ethereum via Wormhole WTT, the user gets `USDCet` (`A9mU...`) on Solana, then Jupiter routes it through obscure pools at a 5% spread. **Fix:** prefer CCTP for USDC; if you must use WTT, surface the wrapped mint clearly and offer to swap to native via Jupiter.

2. **Missing claim step on lock-and-mint.** Wormhole WTT requires a redeem on the destination chain. Auto-relayers usually do this for you, but they can fail (gas spikes, relayer down, large amount limit). **Fix:** check the VAA status after ~15 min; if unclaimed, call `redeemOnSolana` yourself. Have a "stuck transfers" recovery flow.

3. **Slippage on liquidity bridges.** Allbridge and any AMM-style route can give the user 3-5% less than the quote during volatility. `slippageBps: 'auto'` on Mayan is usually fine; on Allbridge set it explicitly and check pool TVL against your transfer size.

4. **RPC latency causing premature retries.** You broadcast a Solana claim tx, your RPC says "not found" 1 second later, your retry logic sends a duplicate. Now you have two pending txs and possibly a "transfer already redeemed" error on the second one. **Fix:** use `getSignatureStatus` with `commitment: 'confirmed'` and a 60s confirm window before retry. Bridge claim txs are not Jupiter swaps — they are *not* time-sensitive, give them room.

5. **Gas / SOL estimation gaps.** Solana destination claims require ~0.002 SOL for account rent and priority fee. If the destination wallet has 0 SOL, the claim fails. **Fix:** when bridging to a new Solana wallet, use a route that supports `gasDrop` (Mayan supports this — set `gasDrop: 0.01` in the quote params to give the user starter SOL).

6. **Oracle / attestation delays during congestion.** Ethereum gas spikes and CCTP attestations queue up; Wormhole guardian latency rises during memecoin runs. Your "should-be-30-seconds" bridge is now at 8 minutes. **Fix:** show the user a live ETA pulled from the bridge's status API rather than a hardcoded "~30 seconds." Set retry/refund timeouts to 4× the typical finality time, not 2×.

7. **Picking the wrong USDC mint on Solana.** This is so common it deserves its own bullet beyond #1. Hardcode `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` as a constant named `USDC_MINT` in your codebase. If a function ever accepts a "USDC mint" parameter, it's a bug waiting to happen.

8. **Treating quote TTL as infinite.** Mayan quotes are ~60s, deBridge `create-tx` responses are ~30s. If the user clicks "confirm" 2 minutes after seeing the quote, you must re-quote before signing. Otherwise the solver rejects the order and the user sees a confusing revert.

## References

- `scripts/bridge-via-mayan.ts` — full Mayan Swift bridge ETH→SOL USDC with status polling
- `scripts/bridge-via-debridge.ts` — full deBridge DLN bridge ETH→SOL USDC via HTTP API
- `references/bridge-comparison.md` — fee, finality, security model side-by-side
- Mayan docs: https://docs.mayan.finance/
- Mayan SDK example repo: https://github.com/mayan-finance/sdk-example
- deBridge docs: https://docs.debridge.com/
- deBridge create-tx Swagger: https://dln.debridge.finance/v1.0
- Wormhole TS SDK: https://github.com/wormhole-foundation/wormhole-sdk-ts
- Wormhole Connect (drop-in UI): https://wormhole.com/docs/products/connect/
- Circle CCTP docs: https://developers.circle.com/cctp
- Circle CCTP Solana reference: https://github.com/circlefin/solana-cctp-contracts
- Allbridge Core SDK: https://github.com/allbridge-io/allbridge-core-js-sdk
- Across docs: https://docs.across.to/

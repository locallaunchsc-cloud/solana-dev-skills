---
name: solana-pyth-oracle
description: Use this skill when the user wants to integrate Pyth price feeds into a Solana or Anchor program — find feed IDs, update on-chain price accounts (pull oracle model), read prices in instructions, handle staleness and confidence intervals safely.
---

# Pyth Oracle

## Overview
Pyth is the dominant oracle on Solana — hundreds of feeds (crypto, FX, equities, commodities) sourced from first-party publishers (Jane Street, Jump, CBOE, Wintermute, …) and aggregated on Pythnet. As of May 2026 the canonical integration on Solana is the **pull model**: prices live off-chain on Pythnet, you fetch the latest signed update from the **Hermes** web service, and your transaction posts it to the **Pyth Solana Receiver** program on the same Solana transaction that consumes it. The older push model (fixed `Crypto.SOL/USD` account at a known address) is **deprecated** for new integrations — the on-chain Solana sponsored price feed accounts have been progressively turned down since late 2024 and most tutorials online still show the dead path. This skill covers the pull model only.

## When to use this skill
- The user asks "how do I get the price of SOL/BTC/ETH/USDC in my Solana program"
- They mention Pyth, oracle, `PriceUpdateV2`, `pyth-solana-receiver-sdk`, Hermes
- They're building anything that touches USD value on-chain: lending, perps, AMM TWAP guard, liquidations, dollar-denominated mint price, collateralization check, payout in SOL of a fiat-denominated amount
- They have stale-tutorial code calling `load_price_feed_from_account_info` against a hard-coded `Crypto.SOL/USD` pubkey and getting `AccountNotFound`

Skip this skill if the user wants sub-100ms latency for an HFT-style use case — that's **Pyth Lazer**, a separate product (`@pythnetwork/pyth-lazer-solana-sdk`), not covered here.

## Prerequisites
- Anchor `0.31.x` or `0.32.x` (the SDK officially supports 0.28, 0.29, 0.30.1, 0.31.1; current 1.x line tracks Anchor 0.32.x)
- Rust crate (in your program's `Cargo.toml`):
  ```toml
  [dependencies]
  pyth-solana-receiver-sdk = "1.2.0"   # latest, tracks anchor-lang 0.32.x
  anchor-lang = "0.32.1"
  ```
  Note: if your program is still on Anchor `0.31.x`, pin `pyth-solana-receiver-sdk = "0.6.1"` instead — that's the last release before the 1.x line bumped `anchor-lang` to 0.32.x. The import paths and structs used in this skill (`PriceUpdateV2`, `get_feed_id_from_hex`, `get_price_no_older_than`) are **identical** across 0.6.x and 1.x.
- TS client (`package.json`):
  ```json
  {
    "dependencies": {
      "@pythnetwork/pyth-solana-receiver": "^0.15.0",
      "@pythnetwork/hermes-client": "^2.0.0",
      "@coral-xyz/anchor": "^0.31.1",
      "@solana/web3.js": "^1.98.4"
    }
  }
  ```
- A Solana RPC endpoint that supports `sendTransaction` with `maxSupportedTransactionVersion: 0` (versioned tx are required — the post-update tx is large and uses ALTs)
- Funded keypair on the target cluster (devnet/mainnet). A pull update costs ~0.001 SOL of transient rent that you reclaim by closing the price update account after consumption.

## Workflow

### 1. Find the feed ID
Every feed is identified by a 32-byte hex ID, **the same across every chain** (Solana, EVM, Aptos, …). Look it up at [pyth.network/developers/price-feed-ids](https://www.pyth.network/developers/price-feed-ids) or hit Hermes directly:

```
curl 'https://hermes.pyth.network/v2/price_feeds?query=SOL/USD&asset_type=crypto'
```

Top crypto feed IDs (verified May 2026):

| Pair      | Feed ID (hex, 0x-prefixed)                                           |
| --------- | -------------------------------------------------------------------- |
| SOL/USD   | `0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d` |
| BTC/USD   | `0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43` |
| ETH/USD   | `0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace` |
| USDC/USD  | `0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a` |

### 2. Fetch the latest signed update from Hermes
Hermes is the public web service that streams Pyth updates off Pythnet. It returns a base64 VAA (Wormhole-signed price message) that the on-chain receiver will verify.

```ts
import { HermesClient } from "@pythnetwork/hermes-client";

const hermes = new HermesClient("https://hermes.pyth.network/", {});
const SOL_USD = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

const { binary: { data: priceUpdateData } } =
  await hermes.getLatestPriceUpdates([SOL_USD], { encoding: "base64" });
```

`priceUpdateData` is `string[]` (one entry per VAA). Hold onto it for step 3.

### 3. Post the update on-chain
`PythSolanaReceiver` from the TS SDK builds a 2-stage transaction set: (a) post the update — this creates an **ephemeral `PriceUpdateV2` account** owned by the receiver program, deterministically derived from the random keypair the SDK injects; (b) your consumer instruction reads that account; (c) optionally close the account to reclaim rent.

```ts
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";

const receiver = new PythSolanaReceiver({ connection, wallet });
const txBuilder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });

await txBuilder.addPostPriceUpdates(priceUpdateData);

await txBuilder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
  const priceUpdate = getPriceUpdateAccount(SOL_USD); // <-- pass to your program
  return [
    await myProgram.methods.consumePrice()
      .accounts({ priceUpdate })
      .instruction(),
  ];
});

await receiver.provider.sendAll(
  await txBuilder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 50_000 }),
  { skipPreflight: true },
);
```

The same builder handles posting **multiple feeds in one tx** — pass an array of VAAs to `addPostPriceUpdates` and call `getPriceUpdateAccount(feedId)` for each one inside the consumer callback.

### 4. Consume the update inside Anchor
On the Rust side, declare a `PriceUpdateV2` account in your `#[derive(Accounts)]` and call `get_price_no_older_than`. This single call does **three** things at once: deserializes, checks the feed ID matches what you expect, and rejects anything older than `maximum_age` seconds.

```rust
use pyth_solana_receiver_sdk::price_update::{get_feed_id_from_hex, PriceUpdateV2};

#[derive(Accounts)]
pub struct ConsumePrice<'info> {
    pub price_update: Account<'info, PriceUpdateV2>,
    pub signer: Signer<'info>,
}

pub fn consume_price(ctx: Context<ConsumePrice>) -> Result<()> {
    const SOL_USD_FEED: &str =
        "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
    const MAX_AGE_SEC: u64 = 60;

    let feed_id = get_feed_id_from_hex(SOL_USD_FEED)?;
    let price = ctx.accounts.price_update.get_price_no_older_than(
        &Clock::get()?,
        MAX_AGE_SEC,
        &feed_id,
    )?;

    // price.price : i64   (scaled by 10^price.exponent, which is negative)
    // price.conf  : u64   (same scaling)
    // price.exponent : i32
    msg!("Price: {} ± {} × 10^{}", price.price, price.conf, price.exponent);
    Ok(())
}
```

### 5. Apply safety checks the SDK doesn't do for you
`get_price_no_older_than` enforces age + feed ID, but **does not** bound confidence. In production add an explicit confidence guard before using the value:

```rust
// Reject if conf > 1% of price — typical liquidation-engine threshold.
let conf_bps = (price.conf as u128)
    .checked_mul(10_000).unwrap()
    .checked_div(price.price.unsigned_abs() as u128).unwrap();
require!(conf_bps <= 100, MyError::PriceTooUncertain);
```

### 6. Convert the integer price to a real number
Pyth prices are `i64` scaled by `10^exponent`. `exponent` is **negative** (typically `-8` for crypto). To express "this much asset is worth $X":

```rust
// value_usd = amount × price × 10^expo
//   where amount is in the asset's smallest unit (lamports for SOL).
// For SOL exponent=-8: 1 SOL × 150_00000000 × 10^-8 = $150.
let amount_lamports: u64 = 1_000_000_000; // 1 SOL
let scaled = (amount_lamports as i128)
    .checked_mul(price.price as i128).unwrap();
// `scaled` now has 9 (lamports) + 8 (Pyth) = 17 decimal places of precision.
// Divide by 10^17 to get whole USD; keep more precision if you store fixed-point.
```

Never use floats on-chain. If your downstream math needs sub-cent precision, keep the scaled `i128` and let the consumer divide.

### 7. Close the price update account (optional but recommended)
The TS builder's `closeUpdateAccounts: true` flag appends a close instruction so the ~0.001 SOL of rent flows back to the signer. Leave it on unless you have a reason to keep the account around for the same slot.

## Common pitfalls

- **Push-model rot.** Hundreds of tutorials and Stack Overflow answers still tell you to use `pyth_sdk_solana::load_price_feed_from_account_info` against a fixed pubkey like `H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG` (legacy SOL/USD). These accounts are **no longer being updated** on mainnet for new feeds and the path is deprecated. If you see `load_price_feed_from_account_info` anywhere in 2026 code, replace it.
- **Forgetting to pass the price update account.** With the pull model the account address is **different every transaction** (it's derived from a random keypair the SDK generates). You cannot hard-code it — your program must accept it as an `Account<PriceUpdateV2>` and the TS client must pass it in via the `getPriceUpdateAccount(feedId)` callback.
- **Trusting the account without checking the feed ID.** `Account<PriceUpdateV2>` only checks that the account is owned by the receiver program. An attacker could substitute a `PriceUpdateV2` for, say, DOGE/USD and your "SOL price" code would happily read it. **Always** pass the expected feed ID to `get_price_no_older_than`, which checks it inside the account data.
- **Stale price.** `Clock::get()?.unix_timestamp` is the on-chain time. `price.publish_time` is when Pythnet observed it. A reasonable `MAX_AGE_SEC` is 30–60s; for liquidations or anything adversarial, go tighter (10–20s) — but then you must reliably get Hermes data into the same tx.
- **Ignoring confidence interval.** During flash crashes or thin-market sessions `conf` widens to several percent of `price`. A naïve consumer that reads `price.price` and ignores `price.conf` will mark a position based on a spread mid that no liquidity actually exists at. Always enforce `conf / price ≤ threshold` (1% is a common bar).
- **Exponent direction.** `exponent` is **negative** (`-8` for crypto). New devs sometimes multiply by `10^expo` instead of dividing, which makes a 150 SOL look like `1.5 × 10^-6` instead of $150. The formula is `real_value = price * 10^exponent`.
- **Hermes rate limits.** The public `hermes.pyth.network` is shared and rate-limited (no published limit, but production workloads will hit 429s at sustained traffic). For real volume run your own Hermes (`docker run pythnetwork/hermes`) or use a managed provider.
- **Pull update transaction size.** Posting a VAA + your consumer instruction often exceeds 1232 bytes — that's why the SDK returns `VersionedTransaction[]` (sometimes multiple), uses an address lookup table, and recommends `skipPreflight: true`. Don't try to flatten it into a legacy `Transaction`.
- **EMA vs spot.** `price_message` also carries `ema_price` / `ema_conf` (exponentially-weighted moving average). For mark-to-market on derivatives, the EMA price is the safer field — it's smoother and harder to manipulate within a single slot. Spot is what `get_price_no_older_than` returns by default.

## References
- [Pyth Solana pull integration guide](https://docs.pyth.network/price-feeds/core/use-real-time-data/pull-integration/solana) — canonical docs, kept current
- [pyth-solana-receiver-sdk on docs.rs](https://docs.rs/pyth-solana-receiver-sdk/latest/pyth_solana_receiver_sdk/) — `PriceUpdateV2`, `get_feed_id_from_hex`, `get_price_no_older_than`
- [@pythnetwork/pyth-solana-receiver on npm](https://www.npmjs.com/package/@pythnetwork/pyth-solana-receiver) — `PythSolanaReceiver`, `TransactionBuilder`
- [@pythnetwork/hermes-client on npm](https://www.npmjs.com/package/@pythnetwork/hermes-client) — typed Hermes client
- [Price Feed IDs directory](https://www.pyth.network/developers/price-feed-ids) — full list, filter by chain/asset class
- [Hermes API reference](https://hermes.pyth.network/docs/) — raw HTTP / SSE endpoints
- [pyth-crosschain repo](https://github.com/pyth-network/pyth-crosschain) — receiver program source, Rust + TS SDKs

## Example
See [`scripts/anchor-program.rs`](scripts/anchor-program.rs) for the on-chain Anchor consumer (deserialize → verify feed ID → check staleness → bound confidence → log).

See [`scripts/update-and-consume.ts`](scripts/update-and-consume.ts) for the matching TS client (fetch from Hermes → post via `PythSolanaReceiver` → invoke your program in the same tx).

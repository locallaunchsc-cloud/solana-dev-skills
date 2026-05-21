// Anchor program that consumes a Pyth pull-oracle price update.
//
// Drop-in `programs/<your-program>/src/lib.rs` for an Anchor 0.32.x project.
//
// Cargo.toml (in the same crate):
//
//   [dependencies]
//   anchor-lang              = "0.32.1"
//   pyth-solana-receiver-sdk = "1.2.0"   # latest 1.x; tracks Anchor 0.32.x
//
// If you're still on Anchor 0.31.x, pin `pyth-solana-receiver-sdk = "0.6.1"`
// instead — that's the last release before the 1.x line bumped anchor-lang to
// 0.32.x. The API surface used below (PriceUpdateV2, get_feed_id_from_hex,
// get_price_no_older_than) is identical between 0.6.x and 1.x.
//
// Build:   anchor build
// Test:    anchor test --skip-local-validator   (point at devnet)
// Deploy:  anchor deploy --provider.cluster devnet

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::{get_feed_id_from_hex, PriceUpdateV2};

declare_id!("PythConsumer1111111111111111111111111111111");

// ---- Feed config ----
// SOL/USD on Pyth. Same ID on every chain Pyth supports.
// Look up other feeds at https://www.pyth.network/developers/price-feed-ids
const SOL_USD_FEED_ID: &str =
    "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

// Reject prices older than this many seconds. 60s is a reasonable default for
// non-adversarial use cases. Tighten to 10-20s for liquidations or anything
// where staleness is exploitable.
const MAX_PRICE_AGE_SEC: u64 = 60;

// Reject prices whose confidence interval is wider than this fraction of the
// price itself. 100 bps = 1%. During flash crashes Pyth `conf` can widen to
// several percent of `price` — you almost never want to act on that.
const MAX_CONFIDENCE_BPS: u128 = 100;

#[program]
pub mod pyth_consumer {
    use super::*;

    /// View-style instruction: log the current USD value of `amount_lamports`
    /// worth of SOL, using the supplied Pyth price update account.
    ///
    /// The price update account is produced by `PythSolanaReceiver` on the TS
    /// side and lives only for this transaction (then gets closed for rent).
    pub fn value_of_sol_in_usd(ctx: Context<ValueOfSol>, amount_lamports: u64) -> Result<()> {
        let price_update = &ctx.accounts.price_update;

        // 1. Resolve the expected feed ID. `get_feed_id_from_hex` strips the
        //    optional 0x prefix and returns a [u8; 32].
        let feed_id = get_feed_id_from_hex(SOL_USD_FEED_ID)?;

        // 2. Read the price. This call does THREE things at once:
        //      a. deserializes the account (already done by Anchor, but the
        //         SDK confirms it's a real PriceUpdateV2),
        //      b. checks that the embedded feed_id matches `feed_id` —
        //         without this an attacker could pass any PriceUpdateV2 and
        //         your code would happily use the wrong asset's price,
        //      c. rejects updates older than MAX_PRICE_AGE_SEC seconds.
        let price = price_update.get_price_no_older_than(
            &Clock::get()?,
            MAX_PRICE_AGE_SEC,
            &feed_id,
        )?;

        // 3. Confidence guard. The SDK does not enforce this for you.
        //    `conf` and `price` share the same exponent so the ratio is
        //    well-defined.
        let price_abs = price.price.unsigned_abs() as u128;
        require!(price_abs > 0, PythConsumerError::PriceTooUncertain);
        let conf_bps = (price.conf as u128)
            .checked_mul(10_000)
            .ok_or(PythConsumerError::MathOverflow)?
            .checked_div(price_abs)
            .ok_or(PythConsumerError::MathOverflow)?;
        require!(
            conf_bps <= MAX_CONFIDENCE_BPS,
            PythConsumerError::PriceTooUncertain
        );

        // 4. Sanity-check that the price is positive (Pyth prices for assets
        //    we care about should always be > 0).
        require!(price.price > 0, PythConsumerError::PriceTooUncertain);

        // 5. Convert. Pyth prices are i64 scaled by 10^exponent, where
        //    exponent is negative (typically -8 for crypto). For SOL with
        //    exponent = -8:
        //
        //        value_usd = amount_lamports
        //                  * (1 SOL / 1e9 lamports)
        //                  * price.price
        //                  * 10^price.exponent
        //
        //    We keep everything as scaled integers and emit the components so
        //    downstream programs can carry full precision.
        let scaled_value: i128 = (amount_lamports as i128)
            .checked_mul(price.price as i128)
            .ok_or(PythConsumerError::MathOverflow)?;

        // Total decimals = 9 (lamports → SOL) + (-price.exponent) (Pyth scale).
        // For exponent=-8 that's 17 implied decimals on `scaled_value`.
        let total_decimals: i32 = 9_i32
            .checked_sub(price.exponent)
            .ok_or(PythConsumerError::MathOverflow)?;

        msg!(
            "SOL/USD = {} (conf {}) * 10^{} (publish_time {})",
            price.price,
            price.conf,
            price.exponent,
            price.publish_time,
        );
        msg!(
            "Value of {} lamports in USD (scaled by 10^{}) = {}",
            amount_lamports,
            total_decimals,
            scaled_value,
        );

        Ok(())
    }
}

#[derive(Accounts)]
pub struct ValueOfSol<'info> {
    /// The Pyth price update account, posted in the same transaction by the
    /// TS client via `PythSolanaReceiver.addPostPriceUpdates`. Account owner
    /// is checked automatically by Anchor's `Account<PriceUpdateV2>`
    /// deserialization (must equal the pyth_solana_receiver_sdk program ID).
    pub price_update: Account<'info, PriceUpdateV2>,

    /// Anyone can pay for the instruction; this is a read-only consumer.
    pub signer: Signer<'info>,
}

#[error_code]
pub enum PythConsumerError {
    #[msg("Pyth price confidence is too wide (price is too uncertain to act on)")]
    PriceTooUncertain,
    #[msg("Math overflow while computing USD value")]
    MathOverflow,
}

// programs/hello-program/src/lib.rs
//
// Minimal Anchor counter program. Two instructions:
//   - initialize: creates a Counter account owned by the program, count = 0
//   - increment:  bumps count by 1
//
// Drop this in as `programs/<name>/src/lib.rs` after `anchor init <name>`.
// Replace the declare_id! value with the keypair pubkey Anchor generates for you:
//   solana address -k target/deploy/hello_program-keypair.json
// Then run `anchor keys sync` to write it into Anchor.toml + lib.rs.

use anchor_lang::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod hello_program {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.authority = ctx.accounts.payer.key();
        counter.count = 0;
        msg!("Counter initialized for {}", counter.authority);
        Ok(())
    }

    pub fn increment(ctx: Context<Increment>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count = counter.count
            .checked_add(1)
            .ok_or(CounterError::Overflow)?;
        msg!("Counter is now {}", counter.count);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    // 8 bytes for the Anchor discriminator + Counter::INIT_SPACE for the fields.
    #[account(
        init,
        payer = payer,
        space = 8 + Counter::INIT_SPACE,
    )]
    pub counter: Account<'info, Counter>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Increment<'info> {
    #[account(
        mut,
        has_one = authority,
    )]
    pub counter: Account<'info, Counter>,

    pub authority: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Counter {
    pub authority: Pubkey, // 32
    pub count: u64,        // 8
}

#[error_code]
pub enum CounterError {
    #[msg("Counter overflow")]
    Overflow,
}

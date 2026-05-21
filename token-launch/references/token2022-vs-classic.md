# SPL Token (classic) vs Token-2022 — which one in 2026?

**TL;DR: Use Token-2022 for any new fungible launch. Use classic SPL Token only when you're forced to (a contract or integration that hardcodes the legacy program ID).**

## The two programs

| | SPL Token (classic) | Token-2022 (Token Extensions) |
|---|---|---|
| Program ID | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| Released | 2020 | 2024 (stable; widely adopted by 2025) |
| Mint size | 82 bytes (fixed) | 82 bytes + TLV for each extension |
| ATA program | Same `ATokenGPv...` for both, but the program-ID arg differs |
| Metadata | External (Metaplex PDA derived from mint) | Native on-mint extension (also Metaplex-compatible via the SPL Token Metadata Interface) |
| Wallet support | Universal | Phantom, Backpack, Solflare, Glow — all support since 2024 |
| DEX support | Universal | Raydium CPMM, Meteora DLMM, Orca Whirlpools, Jupiter v6 |

## What Token-2022 adds (extensions)

Each is opt-in per mint. You can mix and match:

- **MetadataPointer + TokenMetadata** — store name/symbol/URI directly in the mint. No more separate Metaplex PDA. ~0.002 SOL cheaper to deploy.
- **TransferFeeConfig** — protocol-level fee skimmed on every transfer. Replaces "tax token" router hacks.
- **InterestBearingConfig** — UI displays a continuously rebased balance. Useful for yield-bearing wrappers.
- **NonTransferable** — soulbound. Burns and ATA creation still work; transfers don't.
- **PermanentDelegate** — a fixed authority that can move/burn tokens from any account. Compliance feature; use carefully.
- **TransferHook** — call out to your own program on every transfer (KYC gating, royalties, etc.).
- **ConfidentialTransfer** — zk-encrypted balances and transfers.
- **DefaultAccountState** — new ATAs start `Frozen` until explicitly thawed.
- **MintCloseAuthority** — close the mint and reclaim rent once supply is burned.
- **CpiGuard** — prevent CPI-based account hijacking.

## When to use which

### Use Token-2022 if:
- You're shipping a new token in 2025+ (memecoin, governance token, RWA, stablecoin).
- You want on-mint metadata (cheaper, simpler, less to break).
- You need any extension (transfer fees, hooks, confidential transfers, interest).
- You want to future-proof — new Solana features land here first.

### Use classic SPL Token only if:
- You're integrating with a deployed program that calls into `TOKEN_PROGRAM_ID` and won't be upgraded (rare, but happens with older Anchor programs).
- You're issuing a wrapped version of a legacy token where parity matters.
- A specific exchange's deposit address still rejects Token-2022 (verify on a case-by-case basis — most major CEXes added support in 2024–2025).

There is **no advantage** to classic SPL Token for a greenfield launch in 2026.

## Migration

You can't "upgrade" a classic mint to Token-2022 in place. The accepted pattern is:

1. Deploy a new Token-2022 mint with the same decimals.
2. Run a 1:1 swap contract (or a snapshot + airdrop).
3. Optionally burn the old supply or leave it as a "legacy" claim window.

Several teams have done this since 2024 (notably the wormhole-wrapped variants). Plan ~1 sprint of engineering plus communications work.

## Gotchas when mixing both

- **Wrong program ID in ATA derivation**: `getAssociatedTokenAddressSync(mint, owner)` defaults to classic. For Token-2022 you **must** pass `TOKEN_2022_PROGRAM_ID` as the 4th argument or you get a different (unusable) address that silently looks valid.
- **Wallet display lag**: a new Token-2022 mint without a `MetadataPointer` extension shows as "Unknown Token" in some wallets even if you registered a Metaplex PDA. Always enable the metadata extension for fungible launches.
- **DEX listing checklist**: before depositing liquidity, confirm the DEX supports the *specific extensions* you enabled. `TransferFeeConfig` and `TransferHook` are the two most likely to break aggregator routing in 2026.

## References

- SPL Token (classic): https://spl.solana.com/token
- Token-2022 program: https://spl.solana.com/token-2022
- Token Extensions guide: https://solana.com/developers/guides/token-extensions/getting-started
- Metadata pointer deep-dive: https://solana.com/developers/guides/token-extensions/metadata-pointer

# Solana Dev Skills

Plug-and-play skills for Solana developers, written in the [Anthropic Skills](https://www.anthropic.com/news/agent-skills) / [Bankr Skills](https://github.com/BankrBot/skills) format.

Each skill is a self-contained directory with a `SKILL.md` that an agent (or human) can follow to accomplish a specific Solana dev task — from scaffolding an Anchor program to safely deploying to mainnet.

> "Publish a skills.md file!" — [@toly](https://twitter.com/toly)

## Install

For an agent like Claude Code:

```
> install the [skill-name] skill from https://github.com/<owner>/solana-dev-skills/tree/main/[skill-name]
```

Or clone the repo and point your agent at the folder.

## Skills

| Skill | Description |
|---|---|
| [anchor-scaffold](anchor-scaffold/) | Bootstrap a new Anchor program. Install toolchain, scaffold a project, write your first instruction, build, test, deploy to devnet. |
| [token-launch](token-launch/) | Launch a Token-2022 fungible token with on-chain metadata, mint supply, revoke authorities, plus LP guidance for Raydium / Meteora / Orca. |
| [program-audit](program-audit/) | Audit a Solana/Anchor program for the most common security bugs — signer checks, PDA validation, reinit attacks, arithmetic, CPI safety. Includes a 60-item checklist, Anchor constraints cheatsheet, and references to real exploits (Wormhole, Mango, Cashio). |
| [jupiter-swap](jupiter-swap/) | Integrate Jupiter, Solana's leading DEX aggregator. Quotes, swaps, slippage handling, priority fees, versioned transactions. |
| [helius-rpc](helius-rpc/) | High-throughput Solana RPC via Helius. DAS NFT/token queries, transaction webhooks (Cloudflare Worker example), enhanced parser, priority fee estimation. |
| [metaplex-nft](metaplex-nft/) | Mint and manage NFT collections using Metaplex MPL-Core. Umi setup, Irys uploads, collection creation, asset minting, verification. |
| [squads-multisig](squads-multisig/) | Set up and operate a Squads V4 multisig. Create, propose, approve, execute. Standard for program upgrade authority and team treasuries. |
| [solana-deploy](solana-deploy/) | Safe mainnet deployment pipeline. Verifiable builds, buffer accounts, priority-fee retries, IDL upload, upgrade authority transfer to multisig, program close. |
| [program-debug](program-debug/) | Debug failing Solana transactions — read logs, decode error codes (Anchor + system + token program), simulate before send, fix compute budget issues. Includes a full error-code lookup table. |
| [pyth-oracle](pyth-oracle/) | Integrate Pyth price feeds using the modern pull-oracle pattern. Hermes price updates, staleness and confidence checks, working Anchor consumer example. |

## Roadmap

The next batch tracks [@mert](https://twitter.com/mert)'s public list of Solana priorities:

- `binary-markets` — onchain prediction / binary markets for tail assets
- `vaults` — Drift / Kamino / Jito vault integration
- `metadao` — futarchy-based capital formation
- `bridges` — Wormhole / deBridge / Mayan / Allbridge

## Contributing

1. Fork this repo and create a branch.
2. `mkdir your-skill-name/` and add a `SKILL.md` (the only required file). Use YAML frontmatter with `name` and `description`.
3. Optionally add `scripts/` for working code and `references/` for deeper docs.
4. Open a PR.

**Guidelines:** Keep `SKILL.md` concise. Include working examples with pinned versions. No marketing fluff.

## License

MIT — see [LICENSE](LICENSE).

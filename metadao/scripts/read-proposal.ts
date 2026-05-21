/**
 * read-proposal.ts
 *
 * Read a MetaDAO futarchy proposal on Solana mainnet and print:
 *   - State (Draft/Pending/Passed/Failed/Removed)
 *   - DAO + tokens (base/quote mints)
 *   - PASS / FAIL AMM spot prices
 *   - PASS / FAIL TWAP oracle prices
 *   - Time remaining in the trading window
 *   - Current pass margin vs the 3% (or -3% team-sponsored) threshold
 *
 * Usage:
 *   export ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com
 *   export ANCHOR_WALLET=~/.config/solana/id.json
 *   PROPOSAL=<proposal_pubkey> npx tsx scripts/read-proposal.ts
 *
 * Verified against:
 *   @metadaoproject/programs   0.1.0-alpha.2
 *   @coral-xyz/anchor          0.29.0
 *   futarchy v0.6 program      FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq
 *   conditional_vault v0.4     VLTX1ishMBbcX3rdBWGssxawAo1Q2X2qxYFYqiGodVg
 *   amm v0.5                   AMMJdEiCCa8mdugg6JPF7gFirmmxisTfDJoSNSUi5zDJ
 */

import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { unpackMint } from "@solana/spl-token";
import BN from "bn.js";

import {
  FUTARCHY_V0_6_PROGRAM_ID,
  CONDITIONAL_VAULT_V0_4_PROGRAM_ID,
  AMM_V0_5_PROGRAM_ID,
  MAINNET_USDC,
  META_MINT,
} from "@metadaoproject/programs";
import { FutarchyClient } from "@metadaoproject/programs/futarchy/v0.6";
import { AmmClient, getAmmAddr } from "@metadaoproject/programs/amm/v0.5";

// ---- Config ---------------------------------------------------------------

const PROPOSAL = new PublicKey(
  process.env.PROPOSAL ??
    // Default: a known META DAO proposal. Override via env for any other.
    "11111111111111111111111111111111",
);

// ---- Setup ----------------------------------------------------------------

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const futarchy = FutarchyClient.createClient({
  provider,
  futarchyProgramId: FUTARCHY_V0_6_PROGRAM_ID,
  conditionalVaultProgramId: CONDITIONAL_VAULT_V0_4_PROGRAM_ID,
});
const amm = AmmClient.createClient({
  provider,
  ammProgramId: AMM_V0_5_PROGRAM_ID,
});

// ---- Helpers --------------------------------------------------------------

/**
 * MetaDAO TWAP prices are stored as `quote_units_per_base_unit * 1e12`.
 * To convert to a UI price (quote/base in whole tokens):
 *   ui = (price * 10^(base_decimals - quote_decimals)) / 1e12
 */
function priceToUi(rawPriceQ64: BN, baseDecimals: number, quoteDecimals: number): number {
  const exp = baseDecimals - quoteDecimals;
  const scale = Math.pow(10, exp) / 1e12;
  // Use string conversion to avoid losing precision on u128
  return Number(rawPriceQ64.toString()) * scale;
}

/**
 * Compute current spot price from constant-product reserves.
 * price = quote_reserve / base_reserve, normalized for decimals.
 */
function spotPriceFromReserves(
  quoteReserve: BN,
  baseReserve: BN,
  baseDecimals: number,
  quoteDecimals: number,
): number {
  if (baseReserve.isZero()) return 0;
  const q = Number(quoteReserve.toString()) / Math.pow(10, quoteDecimals);
  const b = Number(baseReserve.toString()) / Math.pow(10, baseDecimals);
  return q / b;
}

function stateLabel(state: any): string {
  if (state.draft) return `Draft (staked ${state.draft.amountStaked.toString()})`;
  if (state.pending) return "Pending (trading)";
  if (state.passed) return "Passed";
  if (state.failed) return "Failed";
  if (state.removed) return "Removed";
  return "Unknown";
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "ended";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

// ---- Main -----------------------------------------------------------------

async function main() {
  console.log(`Reading proposal: ${PROPOSAL.toBase58()}\n`);

  const proposal = await futarchy.fetchProposal(PROPOSAL);
  if (!proposal) {
    console.error("Proposal not found on the v0.6 program. Try a v0.5 proposal on legacy.metadao.fi.");
    process.exit(1);
  }

  const dao = await futarchy.getDao(proposal.dao);

  // Resolve all derived addresses for this proposal
  const pdas = futarchy.getProposalPdas(
    PROPOSAL,
    dao.baseMint,
    dao.quoteMint,
    proposal.dao,
  );

  // Decimals
  const baseInfo = await provider.connection.getAccountInfo(dao.baseMint);
  const quoteInfo = await provider.connection.getAccountInfo(dao.quoteMint);
  const baseDec = unpackMint(dao.baseMint, baseInfo).decimals;
  const quoteDec = unpackMint(dao.quoteMint, quoteInfo).decimals;

  // ---- Proposal summary -------------------------------------------------
  console.log("=".repeat(72));
  console.log(`PROPOSAL #${proposal.number}`);
  console.log("=".repeat(72));
  console.log(`State            : ${stateLabel(proposal.state)}`);
  console.log(`DAO              : ${proposal.dao.toBase58()}`);
  console.log(`Base mint        : ${dao.baseMint.toBase58()} (${baseDec} dec)`);
  console.log(`Quote mint       : ${dao.quoteMint.toBase58()} (${quoteDec} dec)`);
  console.log(`Proposer         : ${proposal.proposer.toBase58()}`);
  console.log(`Team sponsored   : ${proposal.isTeamSponsored}`);
  console.log(`Pass threshold   : ${proposal.isTeamSponsored ? "-3%" : "+3%"} (TWAP pass vs fail)`);
  console.log(`Duration         : ${formatDuration(proposal.durationInSeconds)}`);

  const nowSec = Math.floor(Date.now() / 1000);
  const enqueued = proposal.timestampEnqueued.toNumber();
  const endsAt = enqueued + proposal.durationInSeconds;
  const remaining = endsAt - nowSec;
  console.log(`Enqueued at      : ${new Date(enqueued * 1000).toISOString()}`);
  console.log(`Ends at          : ${new Date(endsAt * 1000).toISOString()}`);
  console.log(`Time remaining   : ${formatDuration(remaining)}`);
  console.log(`Squads proposal  : ${proposal.squadsProposal.toBase58()}\n`);

  // ---- Conditional mints ------------------------------------------------
  console.log("Conditional mints:");
  console.log(`  pPASS-base     : ${pdas.passBaseMint.toBase58()}`);
  console.log(`  pPASS-quote    : ${pdas.passQuoteMint.toBase58()}`);
  console.log(`  pFAIL-base     : ${pdas.failBaseMint.toBase58()}`);
  console.log(`  pFAIL-quote    : ${pdas.failQuoteMint.toBase58()}`);
  console.log(`  baseVault      : ${pdas.baseVault.toBase58()}`);
  console.log(`  quoteVault     : ${pdas.quoteVault.toBase58()}`);
  console.log(`  question       : ${pdas.question.toBase58()}\n`);

  // ---- AMM state --------------------------------------------------------
  // PASS AMM = AMM PDA for (passBaseMint, passQuoteMint)
  // FAIL AMM = AMM PDA for (failBaseMint, failQuoteMint)
  // PDA derivation lives in the AMM v0.5 SDK (see `getAmmAddr`):
  const [passAmmPda] = getAmmAddr(
    AMM_V0_5_PROGRAM_ID,
    pdas.passBaseMint,
    pdas.passQuoteMint,
  );
  const [failAmmPda] = getAmmAddr(
    AMM_V0_5_PROGRAM_ID,
    pdas.failBaseMint,
    pdas.failQuoteMint,
  );

  // Crank TWAPs first so we read fresh observations (permissionless, cheap)
  try {
    await amm.crankThatTwap(passAmmPda);
    await amm.crankThatTwap(failAmmPda);
  } catch (e) {
    // Cranking is best-effort; can fail if proposal not yet launched or already resolved.
  }

  const passAmm = await amm.fetchAmm(passAmmPda);
  const failAmm = await amm.fetchAmm(failAmmPda);

  function printMarket(label: string, ammAcct: any, ammPda: PublicKey) {
    if (!ammAcct) {
      console.log(`${label} AMM       : (not initialized)`);
      return null;
    }
    const baseReserve = ammAcct.baseAmount as BN;
    const quoteReserve = ammAcct.quoteAmount as BN;
    const spot = spotPriceFromReserves(quoteReserve, baseReserve, baseDec, quoteDec);
    const twap = ammAcct.oracle?.lastPrice
      ? priceToUi(ammAcct.oracle.lastPrice as BN, baseDec, quoteDec)
      : null;
    // Quote-side liquidity (in whole quote tokens) is the most useful proxy for depth
    const quoteLiq = Number(quoteReserve.toString()) / 10 ** quoteDec;

    console.log(`${label} AMM       : ${ammPda.toBase58()}`);
    console.log(`  base reserve   : ${(Number(baseReserve.toString()) / 10 ** baseDec).toFixed(4)}`);
    console.log(`  quote reserve  : ${quoteLiq.toFixed(4)}`);
    console.log(`  spot price     : ${spot.toFixed(6)} quote/base`);
    console.log(`  TWAP price     : ${twap !== null ? twap.toFixed(6) : "n/a"} quote/base`);
    return { spot, twap, quoteLiq };
  }

  console.log("=".repeat(72));
  const passData = printMarket("PASS", passAmm, passAmmPda);
  console.log("");
  const failData = printMarket("FAIL", failAmm, failAmmPda);
  console.log("=".repeat(72));

  // ---- Pass margin ------------------------------------------------------
  if (passData?.twap != null && failData?.twap != null && failData.twap > 0) {
    const marginPct = ((passData.twap - failData.twap) / failData.twap) * 100;
    const threshold = proposal.isTeamSponsored ? -3 : 3;
    const currentlyWinning = marginPct >= threshold ? "PASS" : "FAIL";
    console.log(`\nCurrent margin   : ${marginPct.toFixed(2)}%  (need ${threshold > 0 ? "≥ +" : "≥ "}${threshold}%)`);
    console.log(`If finalized now : ${currentlyWinning}`);
  }

  // ---- Sanity warning ---------------------------------------------------
  if ((passData?.quoteLiq ?? 0) < 50_000 || (failData?.quoteLiq ?? 0) < 50_000) {
    console.log(
      `\n[!] Thin liquidity warning: one or both conditional markets have ` +
        `< $50k of quote-side reserves. Slippage and TWAP-manipulation risk ` +
        `are elevated; treat the on-chain signal cautiously.`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

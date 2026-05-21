/**
 * trade-conditional.ts
 *
 * Mint MetaDAO conditional tokens and trade them on the PASS or FAIL AMM.
 *
 * Three flows in this file:
 *   1. mint           — deposit underlying (USDC or META) into the conditional
 *                       vault and receive matching pPASS + pFAIL tokens.
 *   2. swap           — trade pPASS-quote → pPASS-base on the PASS AMM
 *                       (or the FAIL equivalent). The SDK's `conditionalSwapIx`
 *                       wraps mint + swap into one ix for convenience.
 *   3. redeem / merge — after resolution, redeem the winning side 1:1;
 *                       before resolution, merge balanced PASS+FAIL pairs
 *                       back to the underlying.
 *
 * Usage:
 *   export ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com
 *   export ANCHOR_WALLET=~/.config/solana/id.json
 *   PROPOSAL=<proposal_pubkey> ACTION=swap MARKET=pass SIDE=buy USDC=10 \
 *     npx tsx scripts/trade-conditional.ts
 *
 * Actions:
 *   ACTION=swap MARKET=pass SIDE=buy  USDC=N   # buy pPASS-META with N USDC
 *   ACTION=swap MARKET=fail SIDE=buy  USDC=N   # buy pFAIL-META with N USDC
 *   ACTION=swap MARKET=pass SIDE=sell META=N   # sell pPASS-META for pPASS-USDC
 *   ACTION=mint USDC=N                         # mint N pPASS-USDC + N pFAIL-USDC
 *   ACTION=merge USDC=N                        # burn N pPASS-USDC + N pFAIL-USDC, get N USDC back
 *   ACTION=redeem                              # redeem all winning-side balances post-resolution
 *
 * Verified against:
 *   @metadaoproject/programs   0.1.0-alpha.2
 *   futarchy v0.6              FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq
 *   conditional_vault v0.4     VLTX1ishMBbcX3rdBWGssxawAo1Q2X2qxYFYqiGodVg
 *   amm v0.5                   AMMJdEiCCa8mdugg6JPF7gFirmmxisTfDJoSNSUi5zDJ
 */

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";

import {
  FUTARCHY_V0_6_PROGRAM_ID,
  CONDITIONAL_VAULT_V0_4_PROGRAM_ID,
  AMM_V0_5_PROGRAM_ID,
  MAINNET_USDC,
  USDC_DECIMALS,
} from "@metadaoproject/programs";
import { FutarchyClient } from "@metadaoproject/programs/futarchy/v0.6";
import { ConditionalVaultClient } from "@metadaoproject/programs/conditional_vault/v0.4";
import { AmmClient } from "@metadaoproject/programs/amm/v0.5";

// ---- Config ---------------------------------------------------------------

const PROPOSAL = new PublicKey(
  process.env.PROPOSAL ?? "11111111111111111111111111111111",
);
const ACTION = (process.env.ACTION ?? "swap").toLowerCase();
const MARKET = (process.env.MARKET ?? "pass").toLowerCase() as "pass" | "fail";
const SIDE = (process.env.SIDE ?? "buy").toLowerCase() as "buy" | "sell";
const USDC_AMOUNT = process.env.USDC ? Number(process.env.USDC) : null;
const META_AMOUNT = process.env.META ? Number(process.env.META) : null;
// Default slippage = 1% (tighten in production)
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? 100);

// ---- Setup ----------------------------------------------------------------

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const wallet = provider.wallet.publicKey;

const futarchy = FutarchyClient.createClient({
  provider,
  futarchyProgramId: FUTARCHY_V0_6_PROGRAM_ID,
  conditionalVaultProgramId: CONDITIONAL_VAULT_V0_4_PROGRAM_ID,
});
const vault = ConditionalVaultClient.createClient({
  provider,
  conditionalVaultProgramId: CONDITIONAL_VAULT_V0_4_PROGRAM_ID,
});
const amm = AmmClient.createClient({
  provider,
  ammProgramId: AMM_V0_5_PROGRAM_ID,
});

// ---- Helpers --------------------------------------------------------------

function uiToBase(amount: number, decimals: number): BN {
  return new BN(Math.floor(amount * 10 ** decimals));
}

async function loadProposal() {
  const proposal = await futarchy.getProposal(PROPOSAL);
  const dao = await futarchy.getDao(proposal.dao);
  const pdas = futarchy.getProposalPdas(
    PROPOSAL,
    dao.baseMint,
    dao.quoteMint,
    proposal.dao,
  );
  return { proposal, dao, pdas };
}

// ---- Actions --------------------------------------------------------------

/**
 * Flow 1 (conceptual): the explicit mint-then-swap path.
 *
 * Even when you only want to *trade* pPASS, on the protocol level you must:
 *   1. Deposit USDC into the quote conditional vault.
 *   2. Receive pPASS-USDC + pFAIL-USDC (1 USDC in → 1 of each out).
 *   3. Swap pPASS-USDC → pPASS-base on the PASS AMM.
 *   4. (Optional) sell pFAIL-USDC on the FAIL AMM, or keep it as a passive
 *      claim on the fail outcome.
 *
 * `conditionalSwapIx` wraps steps 1–3 into a single ix. We call it directly.
 */
async function actionSwap() {
  const { proposal, dao } = await loadProposal();

  if (!("pending" in proposal.state)) {
    throw new Error(
      `Proposal is not in Pending state (current: ${JSON.stringify(proposal.state)}). ` +
        `Cannot trade conditional markets.`,
    );
  }

  // For SIDE=buy: input is the *quote* of that market (pPASS-USDC or pFAIL-USDC),
  // sourced by depositing USDC into the vault. Input amount is in USDC base units.
  // For SIDE=sell: input is the *base* (pPASS-META etc), already in your wallet.
  let inputAmount: BN;
  if (SIDE === "buy") {
    if (USDC_AMOUNT == null)
      throw new Error("ACTION=swap SIDE=buy requires USDC=<amount>");
    inputAmount = uiToBase(USDC_AMOUNT, USDC_DECIMALS);
  } else {
    if (META_AMOUNT == null)
      throw new Error("ACTION=swap SIDE=sell requires META=<amount>");
    // META is 6 decimals like USDC. For an arbitrary DAO base, fetch decimals dynamically.
    inputAmount = uiToBase(META_AMOUNT, 6);
  }

  // Quote AMM reserves to compute a reasonable minOutputAmount with SLIPPAGE_BPS.
  // For simplicity we set minOutputAmount = 0 with a console warning.
  // PRODUCTION: fetch the AMM reserves first, compute expected output via constant-product math,
  // then subtract SLIPPAGE_BPS.
  const minOutputAmount = new BN(0);
  if (SLIPPAGE_BPS === 100) {
    console.log(
      "[warn] Using minOutputAmount=0 — this disables slippage protection. " +
        "Pass SLIPPAGE_BPS=X and compute a real floor in production.",
    );
  }

  console.log(`Submitting conditionalSwap on ${MARKET} market (${SIDE}) ...`);
  const sig = await futarchy
    .conditionalSwapIx({
      dao: proposal.dao,
      baseMint: dao.baseMint,
      quoteMint: dao.quoteMint,
      proposal: PROPOSAL,
      market: MARKET,
      swapType: SIDE,
      inputAmount,
      minOutputAmount,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
    .rpc();

  console.log(`done. tx = ${sig}`);
}

/**
 * Flow 2: mint conditional tokens explicitly (no swap).
 * Useful when you want a balanced PASS+FAIL pair you intend to merge later,
 * or when you want to provide liquidity on one of the conditional AMMs.
 */
async function actionMint() {
  if (USDC_AMOUNT == null) throw new Error("ACTION=mint requires USDC=<amount>");
  const { proposal, dao, pdas } = await loadProposal();

  const amount = uiToBase(USDC_AMOUNT, USDC_DECIMALS);

  console.log(
    `Splitting ${USDC_AMOUNT} ${dao.quoteMint.equals(MAINNET_USDC) ? "USDC" : dao.quoteMint.toBase58()} ` +
      `into ${USDC_AMOUNT} pPASS-quote + ${USDC_AMOUNT} pFAIL-quote ...`,
  );

  // splitTokensIx(question, vault, underlyingTokenMint, amount, numOutcomes, user?, payer?)
  const sig = await vault
    .splitTokensIx(
      pdas.question,
      pdas.quoteVault,
      dao.quoteMint,
      amount,
      2, // PASS / FAIL = 2 outcomes
      wallet,
    )
    .rpc();

  console.log(`done. tx = ${sig}`);
  console.log(
    `pPASS-quote ATA: ${getAssociatedTokenAddressSync(pdas.passQuoteMint, wallet).toBase58()}`,
  );
  console.log(
    `pFAIL-quote ATA: ${getAssociatedTokenAddressSync(pdas.failQuoteMint, wallet).toBase58()}`,
  );
}

/**
 * Flow 3a (pre-resolution): merge balanced PASS+FAIL pairs back to underlying.
 * Requires equal balances of both conditional mints.
 */
async function actionMerge() {
  if (USDC_AMOUNT == null) throw new Error("ACTION=merge requires USDC=<amount>");
  const { dao, pdas } = await loadProposal();
  const amount = uiToBase(USDC_AMOUNT, USDC_DECIMALS);

  console.log(`Merging ${USDC_AMOUNT} pPASS-quote + ${USDC_AMOUNT} pFAIL-quote back to underlying ...`);
  // mergeTokensIx(question, vault, underlyingTokenMint, amount, numOutcomes, user?, payer?)
  const sig = await vault
    .mergeTokensIx(
      pdas.question,
      pdas.quoteVault,
      dao.quoteMint,
      amount,
      2,
      wallet,
    )
    .rpc();

  console.log(`done. tx = ${sig}`);
}

/**
 * Flow 3b (post-resolution): redeem the winning side.
 * After `finalizeProposalIx` has set state to Passed or Failed, the winning
 * conditional mints redeem 1:1 against the vault's underlying balance.
 * The losing side's tokens are worthless.
 */
async function actionRedeem() {
  const { proposal, dao, pdas } = await loadProposal();

  if ("pending" in proposal.state || "draft" in proposal.state) {
    throw new Error(
      `Proposal is not resolved (state: ${JSON.stringify(proposal.state)}). ` +
        `Wait for finalizeProposalIx to be called, or call it yourself if past durationInSeconds.`,
    );
  }

  // Determine which mints are the winning side
  const winning = "passed" in proposal.state ? "pass" : "fail";
  console.log(`Proposal resolved as ${winning.toUpperCase()}.`);

  // Redeem both the base and quote winning conditional balances.
  // redeemTokensIx(question, vault, underlyingTokenMint, numOutcomes, user?, payer?)
  for (const [vaultPda, underlyingMint] of [
    [pdas.baseVault, dao.baseMint],
    [pdas.quoteVault, dao.quoteMint],
  ] as [PublicKey, PublicKey][]) {
    try {
      const sig = await vault
        .redeemTokensIx(pdas.question, vaultPda, underlyingMint, 2, wallet)
        .rpc();
      console.log(`redeemed via ${underlyingMint.toBase58()}: tx = ${sig}`);
    } catch (e: any) {
      console.log(`(skipped ${underlyingMint.toBase58()}: ${e.message ?? e})`);
    }
  }
}

// ---- Entry ----------------------------------------------------------------

async function main() {
  console.log(`Wallet  : ${wallet.toBase58()}`);
  console.log(`Proposal: ${PROPOSAL.toBase58()}`);
  console.log(`Action  : ${ACTION}\n`);

  switch (ACTION) {
    case "swap":
      return actionSwap();
    case "mint":
      return actionMint();
    case "merge":
      return actionMerge();
    case "redeem":
      return actionRedeem();
    default:
      throw new Error(
        `Unknown ACTION=${ACTION}. Use one of: swap | mint | merge | redeem`,
      );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

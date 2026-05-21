/**
 * bridge-via-mayan.ts
 *
 * Bridge USDC from Ethereum mainnet to Solana mainnet using Mayan Swap SDK.
 * Uses Mayan's Swift v2 route for intent-based, sub-15-second settlement.
 *
 * Tested against:
 *   @mayanfinance/swap-sdk ^10.5.0
 *   ethers ^6.13
 *   @solana/web3.js ^1.95
 *   Node 20+
 *
 * Install:
 *   npm i @mayanfinance/swap-sdk ethers @solana/web3.js
 *
 * Env vars required:
 *   EVM_PRIVATE_KEY     - hex private key of the Ethereum sender
 *   EVM_RPC_URL         - Ethereum RPC (Alchemy / Infura / your own)
 *   SOL_DEST_ADDRESS    - Solana recipient pubkey (base58)
 *
 * Optional:
 *   AMOUNT_USDC         - amount in human units (default: 10)
 *   MAYAN_API_KEY       - integrator key, recommended for production
 *
 * Run:
 *   npx tsx scripts/bridge-via-mayan.ts
 */

import {
  fetchQuote,
  swapFromEvm,
  type Quote,
  type ChainName,
} from '@mayanfinance/swap-sdk';
import {
  Wallet,
  JsonRpcProvider,
  type TransactionResponse,
} from 'ethers';
import { PublicKey } from '@solana/web3.js';

// ---- Constants -----------------------------------------------------------

const ETH_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FROM_CHAIN: ChainName = 'ethereum';
const TO_CHAIN: ChainName = 'solana';
const MAYAN_EXPLORER_API = 'https://explorer-api.mayan.finance/v3/swap/trx';

// ---- Helpers -------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

/**
 * Validate that a string is a real Solana pubkey before we send funds at it.
 * A typo here is the single most common way users lose money on a bridge.
 */
function assertSolanaAddress(addr: string): void {
  try {
    // eslint-disable-next-line no-new
    new PublicKey(addr);
  } catch {
    throw new Error(`Invalid Solana destination address: ${addr}`);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ---- Status polling ------------------------------------------------------

type MayanStatus = {
  clientStatus?: string; // 'INPROGRESS' | 'COMPLETED' | 'REFUNDED' | ...
  status?: string;
  fromTxHash?: string;
  toTxHash?: string;
};

async function pollMayanUntilSettled(
  sourceTxHash: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<MayanStatus> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000; // 5 min — typical Swift is <15s
  const intervalMs = opts.intervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${MAYAN_EXPLORER_API}/${sourceTxHash}`);
      if (res.ok) {
        const data = (await res.json()) as MayanStatus;
        const terminal =
          data.clientStatus === 'COMPLETED' ||
          data.clientStatus === 'REFUNDED' ||
          data.clientStatus === 'CANCELLED';
        console.log(
          `[mayan] clientStatus=${data.clientStatus ?? 'pending'} status=${data.status ?? '-'}`,
        );
        if (terminal) {
          return data;
        }
      } else if (res.status !== 404) {
        // 404 just means Mayan hasn't indexed the tx yet — keep polling
        console.warn(`[mayan] status HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn('[mayan] poll error (will retry):', (err as Error).message);
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for Mayan settlement on tx ${sourceTxHash}`);
}

// ---- Main ----------------------------------------------------------------

async function main(): Promise<void> {
  const evmPrivateKey = requireEnv('EVM_PRIVATE_KEY');
  const evmRpcUrl = requireEnv('EVM_RPC_URL');
  const solDest = requireEnv('SOL_DEST_ADDRESS');
  const amount = Number(process.env.AMOUNT_USDC ?? '10');

  assertSolanaAddress(solDest);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`AMOUNT_USDC must be a positive number, got: ${amount}`);
  }

  console.log(`Bridging ${amount} USDC from ${FROM_CHAIN} -> ${TO_CHAIN}`);
  console.log(`Destination Solana wallet: ${solDest}`);

  // ---- 1. Quote --------------------------------------------------------
  const quotes = await fetchQuote({
    amount,
    fromChain: FROM_CHAIN,
    fromToken: ETH_USDC,
    toChain: TO_CHAIN,
    toToken: SOL_USDC,
    slippageBps: 'auto',
    // gasDrop: 0.005, // uncomment to ship ~0.005 SOL to a fresh wallet so it can transact
    referrer: process.env.MAYAN_REFERRER, // optional Solana address for referral fees
    referrerBps: process.env.MAYAN_REFERRER ? 5 : undefined,
    apiKey: process.env.MAYAN_API_KEY,
  });

  if (!quotes || quotes.length === 0) {
    throw new Error(
      'No routes returned by Mayan. Liquidity may be temporarily unavailable; try again or fall back to another bridge.',
    );
  }
  const quote: Quote = quotes[0]; // cheapest route first
  console.log(
    `[quote] type=${quote.type} expectedOut=${quote.expectedAmountOut} minOut=${quote.minAmountOut} eta~${quote.eta ?? '?'}s`,
  );

  // ---- 2. Approve / permit --------------------------------------------
  // swapFromEvm will handle approve + permit internally for tokens that
  // support EIP-2612. For USDC on Ethereum, permit is supported, so no
  // separate approve tx is needed. If you're bridging a non-permit token,
  // see the Mayan sdk-example evm.ts for the manual approve flow.

  // ---- 3. Bridge -------------------------------------------------------
  const provider = new JsonRpcProvider(evmRpcUrl);
  const signer = new Wallet(evmPrivateKey, provider);
  const sender = await signer.getAddress();

  console.log(`[bridge] submitting tx from ${sender} ...`);
  const swapResult = (await swapFromEvm(
    quote,
    sender,
    solDest,
    null, // referrer params already in quote
    signer as any,
    undefined, // permit is built inside the SDK if supported
    null,
    null,
  )) as TransactionResponse | string;

  if (typeof swapResult === 'string') {
    // For gasless Swift orders, swapFromEvm returns an orderHash string
    // instead of a TransactionResponse. You can query it on Mayan explorer:
    // https://explorer.mayan.finance/swap/{orderHash}
    console.log(`[bridge] gasless order submitted: ${swapResult}`);
    return;
  }

  const txHash = swapResult.hash;
  console.log(`[bridge] source tx submitted: ${txHash}`);
  console.log(`[bridge] explorer: https://explorer.mayan.finance/swap/${txHash}`);

  // ---- 4. Wait for source confirmation --------------------------------
  // We don't strictly need a deep confirmation count — Mayan solvers act on
  // mined transactions and front the destination side themselves. One conf
  // is plenty for the polling endpoint to start returning data.
  await swapResult.wait(1);
  console.log('[bridge] source tx confirmed on Ethereum');

  // ---- 5. Wait for Solana settlement ----------------------------------
  const final = await pollMayanUntilSettled(txHash);
  if (final.clientStatus === 'COMPLETED') {
    console.log(`[done] destination tx: ${final.toTxHash}`);
    console.log(`https://solscan.io/tx/${final.toTxHash}`);
  } else {
    console.warn(`[warn] bridge ended in non-success state: ${final.clientStatus}`);
    console.warn('See explorer for refund / cancel details.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});

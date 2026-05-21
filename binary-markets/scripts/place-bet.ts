/**
 * place-bet.ts
 *
 * Places a YES or NO bet on a Drift BET prediction market.
 *
 * On Drift, prediction markets are perp markets:
 *   - LONG (bid)  = bet YES   (you profit if YES resolves -> 1)
 *   - SHORT (ask) = bet NO    (you profit if NO resolves; YES -> 0)
 *
 * The "price" you set is the YES probability you're willing to pay (0 < p < 1).
 * Always use LIMIT orders on thin tail markets — MARKET orders will eat the book.
 *
 * Usage:
 *   export SOLANA_RPC=https://your-rpc-endpoint
 *   export SOLANA_SECRET="[ ... 64-byte JSON array ... ]"
 *   npx tsx place-bet.ts <marketIndex> <yes|no> <usdcAmount> <yesProbability>
 *
 * Example:
 *   npx tsx place-bet.ts 42 yes 25 0.62
 *     -> Limit-buy YES on market 42 with $25 USDC at 62c per YES token
 *
 * Install:
 *   npm i @drift-labs/sdk @coral-xyz/anchor @solana/web3.js bn.js
 */

import { Connection, Keypair } from '@solana/web3.js';
import {
  DriftClient,
  Wallet,
  BN,
  OrderType,
  PositionDirection,
  PostOnlyParams,
  PRICE_PRECISION,
  BASE_PRECISION,
  QUOTE_PRECISION,
} from '@drift-labs/sdk';

const RPC = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';

function loadKeypair(): Keypair {
  const raw = process.env.SOLANA_SECRET;
  if (!raw) {
    throw new Error('SOLANA_SECRET env var required to place orders');
  }
  const bytes = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(bytes);
}

function isPrediction(contractType: unknown): boolean {
  return typeof contractType === 'object'
    && contractType !== null
    && 'prediction' in (contractType as Record<string, unknown>);
}

function parseArgs() {
  const [marketIndexRaw, sideRaw, usdcRaw, probRaw] = process.argv.slice(2);
  if (!marketIndexRaw || !sideRaw || !usdcRaw || !probRaw) {
    console.error(
      'Usage: place-bet.ts <marketIndex> <yes|no> <usdcAmount> <yesProbability>'
    );
    process.exit(1);
  }
  const marketIndex = Number(marketIndexRaw);
  const side = sideRaw.toLowerCase();
  if (side !== 'yes' && side !== 'no') {
    throw new Error('side must be "yes" or "no"');
  }
  const usdc = Number(usdcRaw);
  const yesProb = Number(probRaw);
  if (!(yesProb > 0 && yesProb < 1)) {
    throw new Error('yesProbability must be strictly between 0 and 1');
  }
  if (!(usdc > 0)) throw new Error('usdcAmount must be > 0');
  if (!Number.isInteger(marketIndex)) throw new Error('marketIndex must be integer');
  return { marketIndex, side: side as 'yes' | 'no', usdc, yesProb };
}

async function main() {
  const { marketIndex, side, usdc, yesProb } = parseArgs();

  const connection = new Connection(RPC, 'confirmed');
  const wallet = new Wallet(loadKeypair());
  const drift = new DriftClient({ connection, wallet, env: 'mainnet-beta' });
  await drift.subscribe();

  const market = drift.getPerpMarketAccount(marketIndex);
  if (!market) throw new Error(`No perp market at index ${marketIndex}`);
  if (!isPrediction(market.contractType)) {
    throw new Error(
      `Market ${marketIndex} is not a prediction market (contractType=${JSON.stringify(market.contractType)})`
    );
  }

  // For NO bets, the limit price the user types is YES probability they're shorting against.
  // PositionDirection: long = buy YES, short = sell YES (= buy NO synthetically)
  const direction =
    side === 'yes' ? PositionDirection.LONG : PositionDirection.SHORT;

  // Size in base asset = USDC / price-per-base.
  // For predictions, oracle "price" is YES probability in PRICE_PRECISION.
  // So 1 base unit represents 1 YES token worth ~$yesProb.
  // base_amount = usdc / yesProb  (in base units)
  const baseAmount = new BN(
    Math.floor((usdc / yesProb) * BASE_PRECISION.toNumber())
  );

  // Price scaled to PRICE_PRECISION (1e6 on Drift)
  const limitPrice = new BN(
    Math.floor(yesProb * PRICE_PRECISION.toNumber())
  );

  const orderParams = {
    orderType: OrderType.LIMIT,
    marketIndex,
    direction,
    baseAssetAmount: baseAmount,
    price: limitPrice,
    postOnly: PostOnlyParams.TRY_POST_ONLY, // never cross the book on thin markets
    reduceOnly: false,
  };

  console.log('Submitting order:');
  console.log({
    marketIndex,
    side,
    direction: side === 'yes' ? 'LONG' : 'SHORT',
    usdc,
    yesProb,
    baseAmount: baseAmount.toString(),
    limitPrice: limitPrice.toString(),
  });

  const txSig = await drift.placePerpOrder(orderParams);
  console.log(`\nOrder submitted: ${txSig}`);
  console.log(`https://solscan.io/tx/${txSig}`);

  await drift.unsubscribe();
}

main().catch((err) => {
  console.error('place-bet failed:', err);
  process.exit(1);
});

/**
 * list-markets.ts
 *
 * Lists active binary (YES/NO) prediction markets on Drift BET.
 *
 * Drift represents prediction markets as perp markets where the contract
 * type is `Prediction`. The oracle price on a prediction market is the
 * implied probability of YES, clamped to [0, 1].
 *
 * Usage:
 *   export SOLANA_RPC=https://your-rpc-endpoint
 *   export SOLANA_SECRET="[ ... 64-byte JSON array ... ]"   # any wallet works; reads are wallet-agnostic
 *   npx tsx list-markets.ts
 *
 * Install:
 *   npm i @drift-labs/sdk @coral-xyz/anchor @solana/web3.js
 *
 * Notes:
 *   - This script only reads onchain state; no transactions are sent.
 *   - You still need a wallet because @drift-labs/sdk requires one to instantiate the client.
 *   - Output: market index, symbol, YES price, 24h base volume, expiry.
 */

import { Connection, Keypair } from '@solana/web3.js';
import {
  DriftClient,
  Wallet,
  BN,
  PRICE_PRECISION,
  BASE_PRECISION,
  convertToNumber,
  // ContractType is an enum-like { perpetual: {} } | { future: {} } | { prediction: {} } union in the IDL
} from '@drift-labs/sdk';

const RPC = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';

function loadKeypair(): Keypair {
  const raw = process.env.SOLANA_SECRET;
  if (!raw) {
    // For read-only use, a throwaway key is fine. Drift just needs *a* wallet for client init.
    return Keypair.generate();
  }
  try {
    const bytes = Uint8Array.from(JSON.parse(raw));
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error('SOLANA_SECRET must be a JSON array of 64 bytes');
  }
}

function decodeSymbol(name: number[] | Uint8Array): string {
  // Drift market `name` is a 32-byte right-padded ASCII array
  return Buffer.from(name).toString('utf8').replace(/\0+$/, '').trim();
}

function isPrediction(contractType: unknown): boolean {
  // The IDL encodes the enum as { prediction: {} } in JS
  return typeof contractType === 'object'
    && contractType !== null
    && 'prediction' in (contractType as Record<string, unknown>);
}

async function main() {
  const connection = new Connection(RPC, 'confirmed');
  const kp = loadKeypair();
  const wallet = new Wallet(kp);

  const drift = new DriftClient({
    connection,
    wallet,
    env: 'mainnet-beta',
  });

  await drift.subscribe();

  const all = drift.getPerpMarketAccounts();
  const predictions = all.filter((m) => isPrediction(m.contractType));

  if (predictions.length === 0) {
    console.log('No active Drift prediction markets found.');
    await drift.unsubscribe();
    return;
  }

  console.log(`Found ${predictions.length} Drift prediction markets:\n`);
  console.log(
    ['idx', 'symbol', 'yes_price', '24h_base_vol', 'expiry_ts']
      .map((s) => s.padEnd(14))
      .join('')
  );
  console.log('-'.repeat(70));

  for (const m of predictions) {
    const symbol = decodeSymbol(m.name);
    const oracle = drift.getOracleDataForPerpMarket(m.marketIndex);
    // For prediction markets the oracle reports YES probability scaled to PRICE_PRECISION
    const yesPrice = convertToNumber(oracle.price, PRICE_PRECISION);
    const baseVol24 = convertToNumber(
      (m.amm as { volume24H?: BN }).volume24H ?? new BN(0),
      BASE_PRECISION
    );
    const expiryTs = m.expiryTs ? Number(m.expiryTs.toString()) : 0;

    console.log(
      [
        String(m.marketIndex).padEnd(14),
        symbol.slice(0, 13).padEnd(14),
        yesPrice.toFixed(3).padEnd(14),
        baseVol24.toFixed(1).padEnd(14),
        (expiryTs ? new Date(expiryTs * 1000).toISOString() : 'n/a').padEnd(14),
      ].join('')
    );
  }

  await drift.unsubscribe();
}

main().catch((err) => {
  console.error('list-markets failed:', err);
  process.exit(1);
});

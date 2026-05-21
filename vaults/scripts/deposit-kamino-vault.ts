/**
 * deposit-kamino-vault.ts
 *
 * Deposit USDC into the Kamino Main Market USDC reserve and read back the
 * obligation's collateral (shares) for that reserve.
 *
 * Kamino's "lending vault" is the per-reserve collateral mint inside the main
 * market. You hold cTokens (shares) inside a VanillaObligation PDA, and the
 * liquidity index does the shares -> underlying conversion.
 *
 * Usage:
 *   pnpm i @solana/web3.js @solana/kit @kamino-finance/klend-sdk \
 *          @solana/spl-token bn.js bs58 dotenv
 *   # .env:
 *   #   RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
 *   #   WALLET_SECRET=<base58 keypair secret>
 *   #   DEPOSIT_USDC=10
 *   npx tsx scripts/deposit-kamino-vault.ts
 *
 * Verified against:
 *   @kamino-finance/klend-sdk  7.3.x
 *   @solana/web3.js            1.98.0
 *
 * Kamino markets:
 *   Main:    7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF
 *   JLP:     DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek
 *   Altcoin: ByYiZxp8QrdN9qbdtaAiePN8AAr3qvTPppNJDpf5DVJ5
 */

import 'dotenv/config';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  KaminoMarket,
  KaminoAction,
  VanillaObligation,
  PROGRAM_ID,
  buildVersionedTransaction,
} from '@kamino-finance/klend-sdk';

const USDC_DECIMALS = 6;
const MAIN_MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

function loadWallet(): Keypair {
  const secret = process.env.WALLET_SECRET;
  if (!secret) throw new Error('WALLET_SECRET missing in .env');
  return Keypair.fromSecretKey(bs58.decode(secret));
}

async function main() {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error('RPC_URL missing in .env');
  const humanAmount = Number(process.env.DEPOSIT_USDC ?? '10');
  const rawAmount = BigInt(Math.round(humanAmount * 10 ** USDC_DECIMALS));

  const connection = new Connection(rpcUrl, 'confirmed');
  const wallet = loadWallet();

  // 1. Load the market (caches reserves, oracle prices, config).
  const market = await KaminoMarket.load(connection, MAIN_MARKET, 450);
  if (!market) throw new Error('Failed to load Kamino main market');

  const usdcReserve = market.getReserveByMint(USDC_MINT);
  if (!usdcReserve) throw new Error('USDC reserve not found in main market');

  console.log('Market:           ', MAIN_MARKET.toBase58());
  console.log('USDC reserve:     ', usdcReserve.address.toBase58());
  console.log('Supply APY:       ', (usdcReserve.totalSupplyAPY() * 100).toFixed(2) + '%');

  // 2. Build the deposit action. Kamino composes setup + lending + cleanup ixs;
  //    you bundle them into one versioned tx yourself.
  const obligationType = new VanillaObligation(PROGRAM_ID);
  const action = await KaminoAction.buildDepositTxns(
    market,
    rawAmount.toString(),
    USDC_MINT,
    wallet.publicKey,
    obligationType,
    true,                          // useV2Ixs
    undefined,                     // scopeRefreshConfig (auto)
  );

  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    ...action.setupIxs,
    ...action.lendingIxs,
    ...action.cleanupIxs,
  ];

  const tx = await buildVersionedTransaction(connection, wallet.publicKey, ixs);
  tx.sign([wallet]);

  // 3. Send.
  const sig = await connection.sendTransaction(tx, { maxRetries: 3 });
  await connection.confirmTransaction(sig, 'confirmed');
  console.log(`Deposited ${humanAmount} USDC. Tx: https://solscan.io/tx/${sig}`);

  // 4. Read back the obligation and convert collateral shares -> underlying.
  const obligationAddress = obligationType.toPda(MAIN_MARKET, wallet.publicKey);
  const obligation = await market.getObligationByAddress(obligationAddress);
  if (!obligation) {
    console.log('Obligation not found yet; try again in a few seconds.');
    return;
  }

  const usdcDeposit = obligation.deposits.get(usdcReserve.address.toBase58());
  if (!usdcDeposit) {
    console.log('No USDC position on obligation.');
    return;
  }

  console.log('--- position ---');
  console.log('Obligation:      ', obligationAddress.toBase58());
  console.log('cToken shares:   ', usdcDeposit.amount.toString());
  console.log(
    'Underlying USDC: ',
    usdcDeposit.marketValueRefreshed.toFixed(6),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

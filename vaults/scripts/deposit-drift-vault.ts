/**
 * deposit-drift-vault.ts
 *
 * Deposit USDC into a Drift Vault and print the resulting share balance.
 *
 * Usage:
 *   pnpm i @solana/web3.js @solana/spl-token @coral-xyz/anchor \
 *          @drift-labs/sdk @drift-labs/vaults-sdk bn.js bs58 dotenv
 *   # .env:
 *   #   RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
 *   #   WALLET_SECRET=<base58 keypair secret>
 *   #   VAULT_PUBKEY=<the vault to deposit into>
 *   #   DEPOSIT_USDC=10           # human amount, optional, defaults to 10
 *   npx tsx scripts/deposit-drift-vault.ts
 *
 * Find live vaults at https://app.drift.trade/vaults/strategy-vaults — click a vault
 * and copy the pubkey from the URL (`/vault/<pubkey>`).
 *
 * Verified against:
 *   @drift-labs/vaults-sdk 0.3.x
 *   @drift-labs/sdk        2.122.0-beta.0
 *   @solana/web3.js        1.98.0
 */

import 'dotenv/config';
import bs58 from 'bs58';
import { BN } from 'bn.js';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Wallet, AnchorProvider, Program } from '@coral-xyz/anchor';
import {
  DriftClient,
  BulkAccountLoader,
  initialize as initDriftSdk,
  getDriftStateAccountPublicKey,
} from '@drift-labs/sdk';
import {
  VaultClient,
  getVaultDepositorAddressSync,
  VAULT_PROGRAM_ID,
  IDL as VAULTS_IDL,
} from '@drift-labs/vaults-sdk';

const USDC_DECIMALS = 6;

function loadWallet(): Keypair {
  const secret = process.env.WALLET_SECRET;
  if (!secret) throw new Error('WALLET_SECRET missing in .env');
  return Keypair.fromSecretKey(bs58.decode(secret));
}

async function main() {
  const rpcUrl = process.env.RPC_URL;
  const vaultStr = process.env.VAULT_PUBKEY;
  const humanAmount = Number(process.env.DEPOSIT_USDC ?? '10');

  if (!rpcUrl) throw new Error('RPC_URL missing in .env');
  if (!vaultStr) throw new Error('VAULT_PUBKEY missing in .env');

  const connection = new Connection(rpcUrl, 'confirmed');
  const keypair = loadWallet();
  const wallet = new Wallet(keypair);
  const vaultPubkey = new PublicKey(vaultStr);
  const amount = new BN(Math.round(humanAmount * 10 ** USDC_DECIMALS));

  // 1. DriftClient — needed because VaultClient routes deposits through Drift's spot market.
  initDriftSdk({ env: 'mainnet-beta' });
  const accountLoader = new BulkAccountLoader(connection, 'confirmed', 1000);
  const driftClient = new DriftClient({
    connection,
    wallet,
    env: 'mainnet-beta',
    accountSubscription: { type: 'polling', accountLoader },
  });
  await driftClient.subscribe();

  // 2. VaultClient — wraps the drift-vaults Anchor program.
  const provider = new AnchorProvider(connection, wallet, AnchorProvider.defaultOptions());
  const program = new Program(VAULTS_IDL as any, VAULT_PROGRAM_ID, provider);
  const vaultClient = new VaultClient({ driftClient, program });

  // 3. Derive depositor PDA and check whether it exists.
  const vaultDepositor = getVaultDepositorAddressSync(
    VAULT_PROGRAM_ID,
    vaultPubkey,
    keypair.publicKey,
  );

  const existing = await connection.getAccountInfo(vaultDepositor);
  console.log('Vault:           ', vaultPubkey.toBase58());
  console.log('VaultDepositor:  ', vaultDepositor.toBase58());
  console.log('First deposit?   ', existing === null);

  // 4. Deposit. The `initVaultDepositor` arg atomically creates the PDA on first deposit.
  const sig = await vaultClient.deposit(
    vaultDepositor,
    amount,
    existing === null
      ? { authority: keypair.publicKey, vault: vaultPubkey }
      : undefined,
  );
  console.log(`Deposited ${humanAmount} USDC. Tx: https://solscan.io/tx/${sig}`);

  // 5. Read back the depositor and convert shares -> underlying.
  await accountLoader.load();
  const vd: any = await vaultClient.getVaultDepositor(vaultDepositor);
  const vault: any = await vaultClient.getVault(vaultPubkey);

  const shares = new BN(vd.vaultShares.toString());
  const totalShares = new BN(vault.totalShares.toString());
  // Vault.totalEquity isn't directly stored; the SDK exposes calculateWithdrawableVaultDepositorEquity
  // which does the conversion correctly (handles pending profit share, HWM, etc.).
  const underlying = await vaultClient.calculateWithdrawableVaultDepositorEquity({
    vaultDepositor: vd,
    vault,
  });

  console.log('--- position ---');
  console.log('Shares:        ', shares.toString());
  console.log('Total shares:  ', totalShares.toString());
  console.log(
    'Underlying:    ',
    (underlying.toNumber() / 10 ** USDC_DECIMALS).toFixed(6),
    'USDC',
  );
  console.log('HWM (per-share):', vd.cumulativeProfitShareAmount?.toString() ?? 'n/a');

  await driftClient.unsubscribe();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

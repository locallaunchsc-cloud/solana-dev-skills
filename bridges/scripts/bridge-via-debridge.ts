/**
 * bridge-via-debridge.ts
 *
 * Bridge USDC from Ethereum mainnet to Solana mainnet using deBridge DLN.
 * Uses the deBridge DLN HTTP API directly (no SDK) — the API gives you a
 * ready-to-sign tx blob, which is ideal for agents / server workflows.
 *
 * Tested against:
 *   deBridge DLN API v1.0 (May 2026)
 *   ethers ^6.13
 *   @solana/web3.js ^1.95
 *   Node 20+
 *
 * Install:
 *   npm i ethers @solana/web3.js
 *
 * Env vars required:
 *   EVM_PRIVATE_KEY     - hex private key of the Ethereum sender
 *   EVM_RPC_URL         - Ethereum RPC
 *   SOL_DEST_ADDRESS    - Solana recipient pubkey (base58)
 *
 * Optional:
 *   AMOUNT_USDC         - amount in human units (default: 10)
 *   DEBRIDGE_REFERRAL_CODE - integrator referral code
 *
 * Run:
 *   npx tsx scripts/bridge-via-debridge.ts
 */

import {
  Wallet,
  JsonRpcProvider,
  Contract,
  parseUnits,
  type TransactionRequest,
} from 'ethers';
import { PublicKey } from '@solana/web3.js';

// ---- Constants -----------------------------------------------------------

// deBridge uses its OWN internal chain IDs that differ from standard chainIds.
// See: https://docs.debridge.com/home/architecture/supported-chains
const DEBRIDGE_CHAIN_IDS = {
  ethereum: 1,
  bsc: 56,
  polygon: 137,
  optimism: 10,
  arbitrum: 42161,
  avalanche: 43114,
  base: 8453,
  linea: 59144,
  solana: 7565164, // <-- Solana's deBridge chain ID
} as const;

const ETH_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const DLN_API_BASE = 'https://dln.debridge.finance/v1.0';
const DLN_ORDER_STATUS_BASE = 'https://dln-api.debridge.finance/v1.0';

// Minimal ERC-20 ABI for the approve step
const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

// ---- Types ---------------------------------------------------------------

interface CreateTxResponse {
  estimation: {
    srcChainTokenIn: { amount: string; tokenAddress: string; decimals: number };
    dstChainTokenOut: { amount: string; tokenAddress: string; decimals: number };
    recommendedSlippage?: number;
    costsDetails?: unknown[];
  };
  tx: {
    to: string;
    data: string;
    value: string; // hex / decimal string
    allowanceTarget?: string;
    allowanceValue?: string;
  };
  orderId?: { hash?: string; salt?: string };
  order?: { approximateFulfillmentDelay?: number };
  fixFee?: string;
}

interface OrderStatusResponse {
  status:
    | 'None'
    | 'Created'
    | 'Fulfilled'
    | 'SentUnlock'
    | 'OrderCancelled'
    | 'SentOrderCancel'
    | 'ClaimedUnlock'
    | 'ClaimedOrderCancel';
  orderId?: string;
  giveOfferWithMetadata?: unknown;
  takeOfferWithMetadata?: unknown;
}

// ---- Helpers -------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

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

// ---- API calls -----------------------------------------------------------

async function buildOrderTx(params: {
  srcChainId: number;
  srcChainTokenIn: string;
  srcChainTokenInAmount: bigint;
  dstChainId: number;
  dstChainTokenOut: string;
  dstChainTokenOutRecipient: string;
  srcChainOrderAuthorityAddress: string;
  dstChainOrderAuthorityAddress: string;
  referralCode?: string;
}): Promise<CreateTxResponse> {
  const url = new URL(`${DLN_API_BASE}/dln/order/create-tx`);
  url.searchParams.set('srcChainId', String(params.srcChainId));
  url.searchParams.set('srcChainTokenIn', params.srcChainTokenIn);
  url.searchParams.set('srcChainTokenInAmount', params.srcChainTokenInAmount.toString());
  url.searchParams.set('dstChainId', String(params.dstChainId));
  url.searchParams.set('dstChainTokenOut', params.dstChainTokenOut);
  // 'auto' tells deBridge to compute a reasonable output that profitably
  // attracts a solver. Passing an explicit amount lets you set the floor
  // but you risk the order sitting unfilled.
  url.searchParams.set('dstChainTokenOutAmount', 'auto');
  url.searchParams.set('dstChainTokenOutRecipient', params.dstChainTokenOutRecipient);
  url.searchParams.set('srcChainOrderAuthorityAddress', params.srcChainOrderAuthorityAddress);
  url.searchParams.set('dstChainOrderAuthorityAddress', params.dstChainOrderAuthorityAddress);
  if (params.referralCode) {
    url.searchParams.set('referralCode', params.referralCode);
  }

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`deBridge create-tx failed: ${res.status} ${body}`);
  }
  return (await res.json()) as CreateTxResponse;
}

async function pollDebridgeOrder(
  orderId: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<OrderStatusResponse> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000; // 10 min
  const intervalMs = opts.intervalMs ?? 4_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${DLN_ORDER_STATUS_BASE}/dln/order/${orderId}`);
      if (res.ok) {
        const data = (await res.json()) as OrderStatusResponse;
        console.log(`[debridge] order ${orderId.slice(0, 10)}... status=${data.status}`);
        // Fulfilled = destination side delivered. ClaimedUnlock = solver
        // settled on source side too. Either is a successful UX outcome.
        if (
          data.status === 'Fulfilled' ||
          data.status === 'SentUnlock' ||
          data.status === 'ClaimedUnlock'
        ) {
          return data;
        }
        if (
          data.status === 'OrderCancelled' ||
          data.status === 'SentOrderCancel' ||
          data.status === 'ClaimedOrderCancel'
        ) {
          return data; // terminal, but not success
        }
      } else if (res.status !== 404) {
        console.warn(`[debridge] status HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn('[debridge] poll error (will retry):', (err as Error).message);
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for deBridge order ${orderId}`);
}

// ---- Main ----------------------------------------------------------------

async function main(): Promise<void> {
  const evmPrivateKey = requireEnv('EVM_PRIVATE_KEY');
  const evmRpcUrl = requireEnv('EVM_RPC_URL');
  const solDest = requireEnv('SOL_DEST_ADDRESS');
  const amountHuman = process.env.AMOUNT_USDC ?? '10';

  assertSolanaAddress(solDest);

  const provider = new JsonRpcProvider(evmRpcUrl);
  const signer = new Wallet(evmPrivateKey, provider);
  const sender = await signer.getAddress();

  // USDC has 6 decimals on Ethereum
  const amountWei = parseUnits(amountHuman, 6);

  console.log(`Bridging ${amountHuman} USDC from ethereum -> solana via deBridge DLN`);
  console.log(`From: ${sender}`);
  console.log(`To:   ${solDest}`);

  // ---- 1. Build order tx ----------------------------------------------
  const order = await buildOrderTx({
    srcChainId: DEBRIDGE_CHAIN_IDS.ethereum,
    srcChainTokenIn: ETH_USDC,
    srcChainTokenInAmount: amountWei,
    dstChainId: DEBRIDGE_CHAIN_IDS.solana,
    dstChainTokenOut: SOL_USDC,
    dstChainTokenOutRecipient: solDest,
    srcChainOrderAuthorityAddress: sender,
    dstChainOrderAuthorityAddress: solDest,
    referralCode: process.env.DEBRIDGE_REFERRAL_CODE,
  });

  const expectedOut = order.estimation.dstChainTokenOut.amount;
  const outDecimals = order.estimation.dstChainTokenOut.decimals;
  console.log(
    `[quote] expectedOut=${Number(expectedOut) / 10 ** outDecimals} USDC (decimals=${outDecimals})`,
  );
  if (order.order?.approximateFulfillmentDelay) {
    console.log(`[quote] approx fulfillment: ${order.order.approximateFulfillmentDelay}s`);
  }
  const orderId = order.orderId?.hash;
  if (!orderId) {
    // The API still returns a tx you can broadcast; orderId is recoverable
    // post-broadcast from event logs, but for clean tracking we want it now.
    console.warn('[warn] no orderId in create-tx response — order tracking will be best-effort');
  }

  // ---- 2. Approve USDC to the deBridge router -------------------------
  const router = order.tx.to;
  const allowanceTarget = order.tx.allowanceTarget ?? router;
  const usdc = new Contract(ETH_USDC, ERC20_ABI, signer);
  const current: bigint = await usdc.allowance(sender, allowanceTarget);
  if (current < amountWei) {
    console.log(`[approve] current=${current} needed=${amountWei} — sending approve...`);
    const approveTx = await usdc.approve(allowanceTarget, amountWei);
    await approveTx.wait(1);
    console.log(`[approve] tx ${approveTx.hash}`);
  } else {
    console.log('[approve] sufficient allowance already in place');
  }

  // ---- 3. Broadcast the create-order tx -------------------------------
  const txReq: TransactionRequest = {
    to: order.tx.to,
    data: order.tx.data,
    value: BigInt(order.tx.value || '0'), // includes the protocol fix fee (in ETH)
  };
  console.log(`[bridge] sending order tx to router ${router} ...`);
  const sent = await signer.sendTransaction(txReq);
  console.log(`[bridge] source tx: ${sent.hash}`);
  await sent.wait(1);
  console.log('[bridge] source tx confirmed');

  // ---- 4. Poll order status until destination is filled ---------------
  if (orderId) {
    const final = await pollDebridgeOrder(orderId);
    const success =
      final.status === 'Fulfilled' ||
      final.status === 'SentUnlock' ||
      final.status === 'ClaimedUnlock';
    if (success) {
      console.log(`[done] order fulfilled on Solana — recipient: ${solDest}`);
      console.log(`https://app.debridge.com/orders?orderId=${orderId}`);
    } else {
      console.warn(`[warn] order ended in non-success state: ${final.status}`);
      console.warn(
        'If the order was cancelled, funds can be re-claimed using srcChainOrderAuthorityAddress.',
      );
      process.exitCode = 1;
    }
  } else {
    console.log(
      'Order broadcast; track manually at https://app.debridge.com/orders using the source tx hash.',
    );
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { CONFIG } from './config.js';

const RPC = /^https?:\/\//.test(CONFIG.RPC_URL || '') ? CONFIG.RPC_URL : 'https://api.mainnet-beta.solana.com';
if (!/^https?:\/\//.test(process.env.RPC_URL || '')) {
  console.warn('[solana] RPC_URL missing/invalid — using public mainnet RPC (rate-limited). Set RPC_URL to your Helius/QuickNode URL for real use.');
}
export const connection = new Connection(RPC, 'confirmed');

let _core = null;
export function coreWallet() {
  if (_core) return _core;
  if (!CONFIG.CORE_WALLET_SECRET) throw new Error('CORE_WALLET_SECRET not set');
  _core = Keypair.fromSecretKey(bs58.decode(CONFIG.CORE_WALLET_SECRET));
  return _core;
}

export async function solBalance(pubkey) {
  const lamports = await connection.getBalance(new PublicKey(pubkey));
  return lamports / LAMPORTS_PER_SOL;
}

export function isValidMint(mint) {
  try { new PublicKey(mint); return true; } catch { return false; }
}

// Raw SPL balance (bigint) of `mint` held by `owner`. 0n if no account.
export async function tokenBalance(owner, mint) {
  try {
    const ata = await getAssociatedTokenAddress(new PublicKey(mint), new PublicKey(owner));
    return (await getAccount(connection, ata)).amount;
  } catch { return 0n; }
}

// Sends `lamports` of native SOL from the core wallet to `toPubkey`.
export async function transferSol(toPubkey, lamports) {
  const wallet = coreWallet();
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: wallet.publicKey,
    toPubkey: new PublicKey(toPubkey),
    lamports,
  }));
  const sig = await connection.sendTransaction(tx, [wallet]);
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

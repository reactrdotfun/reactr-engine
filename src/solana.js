import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { CONFIG } from './config.js';

export const connection = new Connection(CONFIG.RPC_URL, 'confirmed');

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

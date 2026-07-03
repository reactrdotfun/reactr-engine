import { PublicKey } from '@solana/web3.js';
import {
  getAssociatedTokenAddress, getAccount, getMint, burnChecked,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { connection, coreWallet } from './solana.js';

// Detects whether a mint is owned by the classic Token program or Token-2022.
async function tokenProgramFor(mintPk) {
  const info = await connection.getAccountInfo(mintPk);
  if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

// Burns the core wallet's full balance of `mint` via SPL burnChecked, using the
// correct token program (classic OR Token-2022 — Pump.fun tokens can be either).
// Never throws — returns { sig } or { reason, error }.
export async function burnAll(mint) {
  const wallet = coreWallet();
  const mintPk = new PublicKey(mint);
  const programId = await tokenProgramFor(mintPk);
  const source = await getAssociatedTokenAddress(mintPk, wallet.publicKey, false, programId);

  // read balance, retrying while a preceding buy settles
  let amount = 0n;
  let decimals = 6;
  for (let i = 0; i < 8; i++) {
    try {
      const acc = await getAccount(connection, source, 'confirmed', programId);
      amount = acc.amount;
      if (amount > 0n) {
        decimals = (await getMint(connection, mintPk, 'confirmed', programId)).decimals;
        break;
      }
    } catch (e) {
      // account not found yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (amount === 0n) return { burned: 0n, reason: 'no_balance' };

  // burn (with the right program), capturing errors instead of throwing
  let lastErr = '';
  for (let i = 0; i < 3; i++) {
    try {
      const sig = await burnChecked(connection, wallet, source, mintPk, wallet, amount, decimals, [], undefined, programId);
      await connection.confirmTransaction(sig, 'confirmed');
      return { burned: amount, sig };
    } catch (e) {
      lastErr = e.message;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return { burned: 0n, reason: 'burn_failed', error: lastErr };
}

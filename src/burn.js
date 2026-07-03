import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, getMint, burnChecked } from '@solana/spl-token';
import { connection, coreWallet } from './solana.js';

// Permanently burns the core wallet's full balance of `mint` via SPL burnChecked
// (reduces total supply). Never throws — returns { sig } on success or
// { reason, error } so the caller can log exactly what happened.
export async function burnAll(mint) {
  const wallet = coreWallet();
  const mintPk = new PublicKey(mint);
  const source = await getAssociatedTokenAddress(mintPk, wallet.publicKey);

  // 1. read balance, retrying while the preceding buy swap settles
  let amount = 0n;
  let decimals = 6;
  for (let i = 0; i < 8; i++) {
    try {
      const acc = await getAccount(connection, source, 'confirmed');
      amount = acc.amount;
      if (amount > 0n) {
        decimals = (await getMint(connection, mintPk)).decimals;
        break;
      }
    } catch (e) {
      // ATA not created yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (amount === 0n) return { burned: 0n, reason: 'no_balance' };

  // 2. burn, retrying a couple times; capture the error instead of throwing
  let lastErr = '';
  for (let i = 0; i < 3; i++) {
    try {
      const sig = await burnChecked(connection, wallet, source, mintPk, wallet, amount, decimals);
      await connection.confirmTransaction(sig, 'confirmed');
      return { burned: amount, sig };
    } catch (e) {
      lastErr = e.message;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return { burned: 0n, reason: 'burn_failed', error: lastErr };
}

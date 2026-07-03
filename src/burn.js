import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, getMint, burnChecked } from '@solana/spl-token';
import { connection, coreWallet } from './solana.js';

// Permanently burns the core wallet's full balance of `mint` via the SPL burn
// instruction (reduces total supply — shows as a real "Burn" on Solscan).
// Retries the balance read so the preceding buy swap has time to settle.
export async function burnAll(mint) {
  const wallet = coreWallet();
  const mintPk = new PublicKey(mint);
  const source = await getAssociatedTokenAddress(mintPk, wallet.publicKey);

  let amount = 0n;
  let decimals = 6;
  for (let i = 0; i < 6; i++) {
    try {
      const acc = await getAccount(connection, source);
      amount = acc.amount;
      if (amount > 0n) {
        decimals = (await getMint(connection, mintPk)).decimals;
        break;
      }
    } catch (e) {
      // ATA not created yet — swap may still be settling
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (amount === 0n) return { burned: 0n, reason: 'no_balance' };

  const sig = await burnChecked(connection, wallet, source, mintPk, wallet, amount, decimals);
  return { burned: amount, sig };
}

import { PublicKey } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, transfer, getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { connection, coreWallet } from './solana.js';
import { BURN_ADDRESS } from './config.js';

// Sends the core wallet's full balance of `mint` to the incinerator (permanent burn).
export async function burnAll(mint) {
  const wallet = coreWallet();
  const mintPk = new PublicKey(mint);
  const source = await getAssociatedTokenAddress(mintPk, wallet.publicKey);

  let amount;
  try { amount = (await getAccount(connection, source)).amount; }
  catch { return { burned: 0n, reason: 'no_balance' }; }
  if (amount === 0n) return { burned: 0n, reason: 'zero' };

  const dest = await getOrCreateAssociatedTokenAccount(connection, wallet, mintPk, new PublicKey(BURN_ADDRESS));
  const sig = await transfer(connection, wallet, source, dest.address, wallet, amount);
  return { burned: amount, sig };
}

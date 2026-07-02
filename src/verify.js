import { PublicKey } from '@solana/web3.js';
import { connection, isValidMint } from './solana.js';

/**
 * Verify a token before registering it.
 * Checks the mint exists on-chain and reads its mint authority.
 *
 * NOTE: Pump.fun's creator-fee-share config is program-specific. To fully verify
 * that 100% of creator fees route to the core wallet AND that admin is revoked,
 * decode the Pump.fun fee-config account for this mint here. That decoding is the
 * one Pump.fun-specific piece to finish before going live — everything else is generic.
 */
export async function verifyToken(mint, coreWalletPubkey) {
  if (!isValidMint(mint)) return { ok: false, reason: 'invalid_mint' };

  const info = await connection.getParsedAccountInfo(new PublicKey(mint));
  if (!info.value) return { ok: false, reason: 'mint_not_found' };

  const parsed = info.value.data?.parsed?.info;
  const checks = {
    mintExists: true,
    mintAuthorityRevoked: parsed ? parsed.mintAuthority === null : null,
    // TODO(pumpfun): decode fee-share config for `mint`, confirm recipient === coreWalletPubkey
    feeRecipientIsCore: null,
    feeShareIs100: null,
    adminRevoked: null,
  };

  const ok = checks.mintExists; // tighten once fee-config decode is wired
  return { ok, checks, reason: ok ? null : 'checks_failed' };
}

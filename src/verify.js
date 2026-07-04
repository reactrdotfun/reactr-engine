import { PublicKey } from '@solana/web3.js';
import { connection } from './solana.js';

const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isValidMint = (m) => typeof m === 'string' && BASE58_RE.test(m);

// BondingCurve layout (pump.fun):
// 8 discriminator | 5 x u64 reserves/supply (40) | 1 complete flag | 32 creator
const CURVE_CREATOR_OFFSET = 8 + 40 + 1;

async function bondingCurveCreator(mintPk) {
  const [curve] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mintPk.toBuffer()],
    PUMP_PROGRAM,
  );
  const info = await connection.getAccountInfo(curve);
  if (!info?.data || info.data.length < CURVE_CREATOR_OFFSET + 32) return { creator: null, complete: null };
  const complete = info.data[8 + 40] === 1;
  const creator = new PublicKey(info.data.subarray(CURVE_CREATOR_OFFSET, CURVE_CREATOR_OFFSET + 32)).toBase58();
  return { creator, complete };
}

// Migrated coins: pump AMM pool stores coin_creator at the tail of the Pool account.
async function ammCreator(mintPk) {
  try {
    const accounts = await connection.getProgramAccounts(PUMP_AMM, {
      dataSlice: { offset: 0, length: 0 },
      filters: [{ memcmp: { offset: 43, bytes: mintPk.toBase58() } }],
    });
    if (!accounts.length) return null;
    const pool = await connection.getAccountInfo(accounts[0].pubkey);
    if (!pool?.data || pool.data.length < 32) return null;
    // coin_creator is the last 32 bytes of the Pool account
    return new PublicKey(pool.data.subarray(pool.data.length - 32)).toBase58();
  } catch { return null; }
}

/**
 * A token qualifies for Reactr only if its Pump.fun creator-fee recipient IS the
 * core wallet — i.e. the coin was launched with creator = core wallet, so 100%
 * of creator fees stream to the engine. Anything else is rejected.
 */
export async function verifyToken(mint, coreWalletPubkey) {
  if (!isValidMint(mint)) return { ok: false, reason: 'invalid_mint' };
  const mintPk = new PublicKey(mint);

  const info = await connection.getParsedAccountInfo(mintPk);
  if (!info.value) return { ok: false, reason: 'mint_not_found' };
  const parsed = info.value.data?.parsed?.info;

  // 1) find the pump.fun creator (bonding curve first, AMM pool if migrated)
  let { creator, complete } = await bondingCurveCreator(mintPk);
  let source = 'bonding_curve';
  if (!creator) {
    creator = await ammCreator(mintPk);
    source = 'amm_pool';
  }
  if (!creator) {
    return {
      ok: false,
      reason: 'not_pumpfun',
      detail: 'No Pump.fun bonding curve or AMM pool found for this mint.',
    };
  }

  // 2) the fee recipient (creator) must be the core wallet
  const feeRecipientIsCore = creator === coreWalletPubkey;
  const checks = {
    mintExists: true,
    mintAuthorityRevoked: parsed ? parsed.mintAuthority === null : null,
    pumpfunCoin: true,
    curveComplete: complete,
    creator,
    creatorSource: source,
    feeRecipientIsCore,
  };

  if (!feeRecipientIsCore) {
    return {
      ok: false,
      reason: 'fees_not_routed_to_core',
      detail: `Creator fees go to ${creator.slice(0, 4)}…${creator.slice(-4)}, not the Reactr core wallet. Launch the coin with the core wallet as creator-fee recipient.`,
      checks,
    };
  }
  return { ok: true, checks, reason: null };
}

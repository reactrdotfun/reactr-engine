import { PublicKey } from '@solana/web3.js';
import { connection } from './solana.js';

const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_FEES_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isValidMint = (m) => typeof m === 'string' && BASE58_RE.test(m);

/**
 * Pump.fun fee sharing lives in a dedicated Sharing Config PDA owned by the
 * pump fees program — NOT in the bonding curve (curve.creator is just the
 * minter). Layout (verified against live mainnet data):
 *   8   discriminator | 8 version u8 | 9 adminRevoked u8 (0=no, 2=revoked)
 *   10  creator (32)  | 42 fee authority (32) | 74 padding (2)
 *   76  shares vec len u32 | 80 recipient[0] (32) | 112 bps[0] u16
 */
async function readSharingConfig(mintPk) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('sharing-config'), mintPk.toBuffer()],
    PUMP_FEES_PROGRAM,
  );
  const info = await connection.getAccountInfo(pda);
  if (!info?.data) return null;
  if (!info.owner.equals(PUMP_FEES_PROGRAM)) return null;
  const d = info.data;
  if (d.length < 114) return null;
  const sharesLen = d.readUInt32LE(76);
  const shares = [];
  for (let i = 0; i < sharesLen; i++) {
    const off = 80 + i * 34; // 32 pubkey + 2 bps
    if (d.length < off + 34) break;
    shares.push({
      recipient: new PublicKey(d.subarray(off, off + 32)).toBase58(),
      bps: d.readUInt16LE(off + 32),
    });
  }
  return {
    adminRevoked: d[9] !== 0,
    creator: new PublicKey(d.subarray(10, 42)).toBase58(),
    shares,
  };
}

// Legacy path: coins minted directly by the core wallet (curve.creator == core).
async function bondingCurveCreator(mintPk) {
  const [curve] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mintPk.toBuffer()],
    PUMP_PROGRAM,
  );
  const info = await connection.getAccountInfo(curve);
  if (!info?.data || info.data.length < 8 + 40 + 1 + 32) return null;
  return new PublicKey(info.data.subarray(49, 81)).toBase58();
}

export async function verifyToken(mint, coreWalletPubkey) {
  if (!isValidMint(mint)) return { ok: false, reason: 'invalid_mint' };
  const mintPk = new PublicKey(mint);

  const info = await connection.getParsedAccountInfo(mintPk);
  if (!info.value) return { ok: false, reason: 'mint_not_found' };

  // 1) PRIMARY: pump.fun fee-sharing config (the "fee share" UI writes this)
  const cfg = await readSharingConfig(mintPk);
  if (cfg) {
    const coreShare = cfg.shares.find((s) => s.recipient === coreWalletPubkey);
    const checks = {
      mintExists: true,
      pumpfunCoin: true,
      sharingConfig: true,
      adminRevoked: cfg.adminRevoked,
      shares: cfg.shares,
      feeRecipientIsCore: !!coreShare,
      coreShareBps: coreShare?.bps ?? 0,
    };
    if (!coreShare) {
      const first = cfg.shares[0];
      return {
        ok: false,
        reason: 'fees_not_routed_to_core',
        detail: first
          ? `Fee share goes to ${first.recipient.slice(0, 4)}…${first.recipient.slice(-4)} (${first.bps / 100}%), not the Reactr core wallet.`
          : 'No fee shares configured for this coin.',
        checks,
      };
    }
    if (coreShare.bps < 10000) {
      return {
        ok: false,
        reason: 'fee_share_below_100',
        detail: `Core wallet receives ${coreShare.bps / 100}% of creator fees — 100% is required.`,
        checks,
      };
    }
    return { ok: true, checks, reason: null };
  }

  // 2) FALLBACK: no sharing config -> legacy check, coin minted BY the core wallet
  const creator = await bondingCurveCreator(mintPk);
  if (!creator) {
    return { ok: false, reason: 'not_pumpfun', detail: 'No Pump.fun coin found for this mint.' };
  }
  if (creator !== coreWalletPubkey) {
    return {
      ok: false,
      reason: 'fees_not_routed_to_core',
      detail: `No fee-sharing config found, and the coin creator is ${creator.slice(0, 4)}…${creator.slice(-4)}, not the core wallet. Set up 100% fee share to the core wallet.`,
      checks: { mintExists: true, pumpfunCoin: true, sharingConfig: false, creator },
    };
  }
  return { ok: true, reason: null, checks: { mintExists: true, pumpfunCoin: true, sharingConfig: false, creator, feeRecipientIsCore: true } };
}

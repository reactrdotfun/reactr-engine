/**
 * PERP ADAPTER — the one piece you must wire + secure before flipping ENABLE_PERPS=true.
 *
 * Firing leveraged positions from a hot wallet is the highest-risk part of the system.
 * It is intentionally left as an adapter (not blind auto-fire) so you configure it
 * deliberately. Implement against Jupiter Perps or Flash Trade:
 *   - Jupiter Perps: https://station.jup.ag/guides/perpetual-exchange/overview
 *   - Flash Trade:   https://docs.flash.trade
 *
 * Each function should build, sign (coreWallet), send and confirm the on-chain tx,
 * and return { sig, positionId }. Until implemented, the engine skips position entry
 * and routes 100% of the perp slice into the derivative buyback instead (safe fallback).
 */
import { CONFIG } from './config.js';

export function perpsEnabled() { return CONFIG.ENABLE_PERPS; }

export async function openLong({ market, collateralLamports, leverage }) {
  throw new Error('perps.openLong not implemented — wire Jupiter/Flash then set ENABLE_PERPS=true');
}

export async function harvest(positionId) {
  throw new Error('perps.harvest not implemented');
}

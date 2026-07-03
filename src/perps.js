/**
 * PERP ADAPTER — Jupiter Perpetuals via the OFFICIAL REST API.
 * ---------------------------------------------------------------------------
 * Jupiter provides a hosted API that builds the transaction server-side:
 *   POST https://perps-api.jup.ag/v2/positions/increase  -> serializedTxBase64
 *   sign locally with the core wallet
 *   POST https://perps-api.jup.ag/v1/transaction/execute -> txid (Jupiter lands it)
 *
 * No Anchor, no IDL, no PDA math — the API returns a ready transaction.
 * This is the same flow jup.ag's own frontend uses.
 *
 * SAFETY:
 *   - PERPS_LIVE=false -> builds the real tx via the API but does NOT execute.
 *     (validates the whole path except the final send)
 *   - PERPS_LIVE=true  -> executes for real.
 *   - Markets: SOL / ETH / BTC only (Jupiter Perps listing).
 *   - Leverage capped by PERPS_MAX_LEVERAGE, size capped by MAX_POSITION_USD.
 */
import { VersionedTransaction } from '@solana/web3.js';
import { CONFIG } from './config.js';
import { coreWallet } from './solana.js';
import { solUsdPrice } from './jupiter.js';

const API = 'https://perps-api.jup.ag';
const MARKETS = ['SOL', 'ETH', 'BTC', 'WBTC'];

export function perpsEnabled() { return CONFIG.ENABLE_PERPS; }

function normMarket(sym) {
  const s = String(sym || '').toUpperCase();
  if (s === 'WBTC') return 'BTC';
  return MARKETS.includes(s) ? s : null;
}

async function jfetch(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: j };
}

/**
 * Open a leveraged long via the Jupiter Perps API.
 * Returns { sig|null, positionId, sizeUsd, leverage, simulated }.
 * Throws for unsupported markets / API errors so the engine can fall back.
 */
export async function openLong({ market, collateralLamports, leverage }) {
  const asset = normMarket(market);
  if (!asset) throw new Error(`market ${market} not on Jupiter Perps (SOL/ETH/BTC) — fallback`);

  const wallet = coreWallet();
  const lev = Math.max(1.1, Math.min(Number(leverage) || 2, CONFIG.PERPS_MAX_LEVERAGE));

  // Cap collateral so position size <= MAX_POSITION_USD
  const solUsd = await solUsdPrice();
  if (!solUsd) throw new Error('no SOL price — fallback');
  let collateralUsd = (collateralLamports / 1e9) * solUsd;
  const maxCollateralUsd = CONFIG.MAX_POSITION_USD / lev;
  if (collateralUsd > maxCollateralUsd) {
    collateralUsd = maxCollateralUsd;
    collateralLamports = Math.floor((collateralUsd / solUsd) * 1e9);
  }
  const sizeUsd = collateralUsd * lev;
  if (sizeUsd < 10) throw new Error(`position $${sizeUsd.toFixed(2)} below $10 min — fallback`);

  // 1) ask Jupiter to build the increase-position transaction
  const { ok, status, data } = await jfetch(`${API}/v2/positions/increase`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asset,
      inputToken: asset,                      // long: collateral in the asset itself (SOL)
      inputTokenAmount: String(collateralLamports),
      leverage: lev.toFixed(1),
      side: 'long',
      walletAddress: wallet.publicKey.toBase58(),
      maxSlippageBps: '300',
    }),
  });
  if (!ok || !data.serializedTxBase64) {
    throw new Error(`jup perps api ${status}: ${data.message || JSON.stringify(data).slice(0, 120)}`);
  }

  // 2) sign locally
  const tx = VersionedTransaction.deserialize(Buffer.from(data.serializedTxBase64, 'base64'));
  tx.sign([wallet]);

  // SAFETY GATE — dry run stops here (the API accepted our request & built a real tx)
  if (!CONFIG.PERPS_LIVE) {
    console.log(`[perps] DRY RUN ok — ${asset} long ${lev}x $${sizeUsd.toFixed(0)} (set PERPS_LIVE=true to execute)`);
    return { sig: null, positionId: null, sizeUsd, leverage: lev, simulated: true };
  }

  // 3) execute via Jupiter's landing infra
  const exec = await jfetch(`${API}/v1/transaction/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'increase-position',
      serializedTxBase64: Buffer.from(tx.serialize()).toString('base64'),
    }),
  });
  if (!exec.data.txid) throw new Error(`jup execute failed: ${exec.data.message || JSON.stringify(exec.data).slice(0, 120)}`);

  return { sig: exec.data.txid, positionId: `${asset}:long`, sizeUsd, leverage: lev, simulated: false };
}

/** Current open positions for the core wallet (from Jupiter's API). */
export async function fetchPositions() {
  const wallet = coreWallet();
  const { data } = await jfetch(`${API}/v1/positions?walletAddress=${wallet.publicKey.toBase58()}`);
  return data.dataList || [];
}

/** Unrealized PnL % for the position on `positionId` ("ASSET:side"). */
export async function unrealizedPct(positionId) {
  const [asset] = String(positionId).split(':');
  const list = await fetchPositions();
  const pos = list.find(p => (p.asset || p.marketMint || '').toUpperCase().includes(asset)) || list[0];
  if (!pos) return null;
  const pnl = parseFloat(pos.pnlAfterFeesUsd ?? pos.pnlUsd ?? 'NaN');
  const collateral = parseFloat(pos.collateralUsd ?? 'NaN');
  if (Number.isNaN(pnl) || Number.isNaN(collateral) || !collateral) return null;
  return (pnl / collateral) * 100;
}

/** Close the position fully. Returns { sig, simulated }. */
export async function harvest(positionId) {
  const wallet = coreWallet();
  const list = await fetchPositions();
  const [asset] = String(positionId).split(':');
  const pos = list.find(p => (p.asset || '').toUpperCase().includes(asset)) || list[0];
  if (!pos) throw new Error('position not found (already closed?)');

  const { ok, status, data } = await jfetch(`${API}/v1/positions/decrease`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asset: pos.asset || asset,
      desiredMint: 'So11111111111111111111111111111111111111112', // receive SOL
      collateralUsdDelta: pos.collateralUsd,
      sizeUsdDelta: pos.sizeUsdDelta ?? pos.sizeUsd,
      positionPubkey: pos.positionPubkey,
      side: pos.side || 'long',
      walletAddress: wallet.publicKey.toBase58(),
      maxSlippageBps: '500',
    }),
  });
  if (!ok || !data.serializedTxBase64) {
    throw new Error(`jup close api ${status}: ${data.message || JSON.stringify(data).slice(0, 120)}`);
  }

  const tx = VersionedTransaction.deserialize(Buffer.from(data.serializedTxBase64, 'base64'));
  tx.sign([wallet]);

  if (!CONFIG.PERPS_LIVE) {
    console.log(`[perps] DRY RUN close ok — ${asset} (set PERPS_LIVE=true to execute)`);
    return { sig: null, simulated: true };
  }

  const exec = await jfetch(`${API}/v1/transaction/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'decrease-position',
      serializedTxBase64: Buffer.from(tx.serialize()).toString('base64'),
    }),
  });
  if (!exec.data.txid) throw new Error(`jup close execute failed: ${exec.data.message || ''}`);
  return { sig: exec.data.txid, simulated: false };
}

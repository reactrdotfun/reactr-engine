// REACTR engine — the autonomous loop.
// Run standalone: `npm run worker`  (or import startEngine from the API process).
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { CONFIG } from './config.js';
import { connection, coreWallet, solBalance, tokenBalance, transferSol } from './solana.js';
import { store } from './store.js';
import { buyToken, sellToken, solUsdPrice } from './jupiter.js';
import { burnAll } from './burn.js';
import { perpsEnabled, openLong, harvest, unrealizedPct } from './perps.js';

const log = (...a) => console.log(new Date().toISOString(), '[engine]', ...a);

async function claimAndAllocate() {
  const wallet = coreWallet();
  const bal = await solBalance(wallet.publicKey);
  if (bal < CONFIG.FEE_CLAIM_THRESHOLD_SOL) return;

  // keep a little SOL for tx fees
  const spendable = Math.max(0, bal - 0.02);
  if (spendable <= 0) return;
  const solUsd = await solUsdPrice(); // USD value of each buyback

  const perpLamports = Math.floor(spendable * (CONFIG.ALLOC_PERP_PCT / 100) * LAMPORTS_PER_SOL);
  const reactrLamports = Math.floor(spendable * (CONFIG.ALLOC_REACTR_PCT / 100) * LAMPORTS_PER_SOL);

  // 30% -> straight $REACTR buyback + burn
  if (reactrLamports > 0 && CONFIG.REACTR_MINT) {
    try {
      const { sig } = await buyToken(CONFIG.REACTR_MINT, reactrLamports);
      log('REACTR buyback', sig);
      const b = await burnAll(CONFIG.REACTR_MINT);
      log('REACTR burn', b.sig || b.reason);
      // USD sizing needs a price feed (TODO) — records buyback count + on-chain tx now.
      store.recordBurn({ mint: CONFIG.REACTR_MINT, market: 'REACTR', side: 'long', burnedUsd: (reactrLamports / LAMPORTS_PER_SOL) * solUsd, tx: b.sig || sig });
    } catch (e) { log('REACTR buyback failed:', e.message); }
  }

  // 70% -> perp collateral (or fallback to derivative buyback if perps disabled)
  const active = store.all().filter(t => t.status === 'active');
  for (const t of active) {
    const slice = Math.floor(perpLamports / Math.max(active.length, 1));
    if (slice <= 0) continue;
    const buybackBurn = async () => {
      const { sig } = await buyToken(t.mint, slice);
      await burnAll(t.mint);
      const usd = (slice / LAMPORTS_PER_SOL) * solUsd;
      store.recordBurn({ mint: t.mint, market: t.linked || t.underlying, side: 'long', sizeUsd: usd, burnedUsd: usd, tx: sig });
      log('buyback+burn', t.mint, sig, `$${usd.toFixed(2)}`);
    };
    try {
      if (perpsEnabled() && !t.positionId) {
        try {
          const pos = await openLong({ market: t.linked || t.underlying, collateralLamports: slice, leverage: t.leverage });
          store.upsert(t.mint, { positionId: pos.simulated ? null : pos.positionId, lastSizeUsd: pos.sizeUsd || 0, lastEntry: Date.now() });
          if (!pos.simulated) store.setPosition(t.mint, { market: t.linked || t.underlying, side: 'long', leverage: pos.leverage, sizeUsd: pos.sizeUsd || 0, pnl: 0 });
          log('perp', pos.simulated ? 'SIMULATED (set PERPS_LIVE=true to fire)' : 'opened', t.mint, pos.sig || '(dry run)');
          if (pos.simulated) await buybackBurn(); // dry-run mode: still do real buyback so fuel is never idle
        } catch (perpErr) {
          // unsupported market / sim failure / any error -> never strand fuel
          log('perp -> fallback', t.mint, perpErr.message);
          await buybackBurn();
        }
      } else if (!perpsEnabled()) {
        await buybackBurn();
      }
    } catch (e) { log('slice failed', t.mint, e.message); }
  }
}

// Harvest positions once they clear the profit threshold; realized profit -> buyback+burn.
async function harvestGreen() {
  if (!perpsEnabled()) return;
  for (const t of store.all()) {
    if (!t.positionId) continue;
    try {
      const pct = await unrealizedPct(t.positionId);
      if (pct == null) continue;
      if (t.lastSizeUsd) store.setPosition(t.mint, { market: t.linked || t.underlying, side: 'long', leverage: t.leverage, sizeUsd: t.lastSizeUsd, pnl: Math.round(t.lastSizeUsd * (pct / 100)) });
      if (pct >= CONFIG.HARVEST_PROFIT_PCT) {
        const res = await harvest(t.positionId);
        log('harvest', t.mint, res.simulated ? 'SIMULATED' : res.sig, `(+${pct.toFixed(1)}%)`);
        if (!res.simulated) {
          store.closePosition(t.mint);
          store.upsert(t.mint, { positionId: null });
          // TODO: route realized USDC -> buy back & burn the derivative (needs USDC swap). Records the win for now.
          const profitUsd = (t.lastSizeUsd || 0) * (pct / 100);
          store.recordBurn({ mint: t.mint, market: t.linked || t.underlying, side: 'long', sizeUsd: t.lastSizeUsd || 0, burnedUsd: profitUsd, pnlUsd: profitUsd, tx: res.sig });
        }
      }
    } catch (e) { log('harvest check failed', t.mint, e.message); }
  }
}

// SWEEP MODE — sell every held token back to SOL, then send all SOL to SWEEP_DESTINATION.
// Guarded: destination is fixed in env, only runs while SWEEP_MODE=true.
async function sweep() {
  const wallet = coreWallet();
  const dest = CONFIG.SWEEP_DESTINATION;
  if (!dest) { log('sweep: SWEEP_DESTINATION not set — aborting'); return; }

  const mints = [...new Set([CONFIG.REACTR_MINT, ...store.all().map(t => t.mint)].filter(Boolean))];
  for (const mint of mints) {
    try {
      const bal = await tokenBalance(wallet.publicKey, mint);
      if (bal > 0n) {
        const { sig } = await sellToken(mint, bal.toString());
        log('sweep sold', mint, sig);
      }
    } catch (e) { log('sweep sell failed', mint, e.message); }
  }

  await new Promise((r) => setTimeout(r, 5000)); // let sells settle
  const bal = await solBalance(wallet.publicKey);
  const send = Math.floor((bal - 0.01) * LAMPORTS_PER_SOL); // keep a little for fees
  if (send > 0) {
    try {
      const sig = await transferSol(dest, send);
      log('sweep SOL ->', dest, sig, `${(send / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    } catch (e) { log('sweep transfer failed:', e.message); }
  } else {
    log('sweep: nothing to send');
  }
}

export async function tick() {
  if (CONFIG.SWEEP_MODE) {
    try { await sweep(); } catch (e) { log('sweep error:', e.message); }
    return; // in sweep mode we only withdraw — no buyback/burn
  }
  try { await claimAndAllocate(); } catch (e) { log('tick error:', e.message); }
  try { await harvestGreen(); } catch (e) { log('harvest error:', e.message); }
}

export function startEngine() {
  log('starting; perps', perpsEnabled() ? 'ENABLED' : 'disabled (fallback mode)');
  tick();
  setInterval(tick, CONFIG.LOOP_SECONDS * 1000);
}

// run directly
if (import.meta.url === `file://${process.argv[1]}`) startEngine();

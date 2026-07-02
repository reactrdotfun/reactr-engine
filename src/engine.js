// REACTR engine — the autonomous loop.
// Run standalone: `npm run worker`  (or import startEngine from the API process).
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { CONFIG } from './config.js';
import { connection, coreWallet, solBalance } from './solana.js';
import { store } from './store.js';
import { buyToken } from './jupiter.js';
import { burnAll } from './burn.js';
import { perpsEnabled, openLong } from './perps.js';

const log = (...a) => console.log(new Date().toISOString(), '[engine]', ...a);

async function claimAndAllocate() {
  const wallet = coreWallet();
  const bal = await solBalance(wallet.publicKey);
  if (bal < CONFIG.FEE_CLAIM_THRESHOLD_SOL) return;

  // keep a little SOL for tx fees
  const spendable = Math.max(0, bal - 0.02);
  if (spendable <= 0) return;

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
      store.recordBurn({ mint: CONFIG.REACTR_MINT, market: 'REACTR', side: 'long', tx: b.sig || sig });
    } catch (e) { log('REACTR buyback failed:', e.message); }
  }

  // 70% -> perp collateral (or fallback to derivative buyback if perps disabled)
  const active = store.all().filter(t => t.status === 'active');
  for (const t of active) {
    const slice = Math.floor(perpLamports / Math.max(active.length, 1));
    if (slice <= 0) continue;
    try {
      if (perpsEnabled()) {
        const pos = await openLong({ market: t.underlying, collateralLamports: slice, leverage: t.leverage });
        store.upsert(t.mint, { positionId: pos.positionId, lastEntry: Date.now() });
        store.setPosition(t.mint, { market: t.linked || t.underlying, side: t.side || 'long', leverage: t.leverage, sizeUsd: 0, pnl: 0 });
        log('opened perp', t.mint, pos.sig);
      } else {
        // safe fallback: no leverage -> buy back & burn the derivative directly
        const { sig } = await buyToken(t.mint, slice);
        await burnAll(t.mint);
        store.recordBurn({ mint: t.mint, market: t.linked || t.underlying, side: 'long', tx: sig });
        log('fallback buyback+burn', t.mint, sig);
      }
    } catch (e) { log('perp slice failed', t.mint, e.message); }
  }
}

export async function tick() {
  try { await claimAndAllocate(); }
  catch (e) { log('tick error:', e.message); }
}

export function startEngine() {
  log('starting; perps', perpsEnabled() ? 'ENABLED' : 'disabled (fallback mode)');
  tick();
  setInterval(tick, CONFIG.LOOP_SECONDS * 1000);
}

// run directly
if (import.meta.url === `file://${process.argv[1]}`) startEngine();

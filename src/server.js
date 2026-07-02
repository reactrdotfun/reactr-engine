import express from 'express';
import cors from 'cors';
import { CONFIG } from './config.js';
import { store } from './store.js';
import { isValidMint, coreWallet } from './solana.js';
import { verifyToken } from './verify.js';
import { startEngine } from './engine.js';

const app = express();
app.use(express.json());

// Bulletproof CORS — reflect the caller's origin (or *) and answer preflight.
const ALLOWED = CONFIG.CORS_ORIGIN;
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allow = ALLOWED.includes('*') ? (origin || '*') : (ALLOWED.includes(origin) ? origin : ALLOWED[0]);
  res.header('Access-Control-Allow-Origin', allow);
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const shortMint = (m = '') => (m ? `${m.slice(0, 4)}…${m.slice(-4)}` : '');
const ago = (ts) => {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Aggregate metrics → { reactions, pnl, burned, buybacks }
app.get('/api/v1/stats', (_req, res) => res.json(store.stats()));

// All registered tokens, shaped for the dashboard + leaderboard
app.get('/api/v1/tokens', (_req, res) =>
  res.json(store.all().map((t) => ({
    name: t.name || shortMint(t.mint),
    linked: t.linked || t.underlying || 'SOL',
    side: t.side || 'long',
    leverage: t.leverage || 100,
    status: t.status || 'pending',
    pnl: t.pnl || 0,
    sizeUsd: t.sizeUsd || 0,
    mint: t.mint,
  })))
);

// Open perpetual positions → { market, side, leverage, sizeUsd, pnl }
app.get('/api/v1/positions', (_req, res) =>
  res.json(store.positions().map((p) => ({
    market: p.market || p.linked || 'SOL',
    side: p.side || 'long',
    leverage: p.leverage || 100,
    sizeUsd: p.sizeUsd || 0,
    pnl: p.pnl || 0,
  })))
);

// Recent buybacks & burns → { time, market, side, size, result, tx }
app.get('/api/v1/history', (_req, res) =>
  res.json(store.history().map((h) => ({
    time: ago(h.ts),
    market: h.market,
    side: h.side || 'long',
    size: h.size || 0,
    result: h.result || 0,
    tx: h.tx || '',
  })))
);

// One token's status + position
app.get('/api/v1/tokens/:mint/status', (req, res) => {
  const t = store.get(req.params.mint);
  if (!t) return res.status(404).json({ error: 'not_registered' });
  res.json(t);
});

// Register a token with the core
app.post('/api/v1/tokens/register', async (req, res) => {
  try {
    const { mint, name, underlying = 'SOL', linked, side = 'long', leverage = 100 } = req.body || {};
    if (!isValidMint(mint)) return res.status(400).json({ error: 'invalid_mint' });
    if (store.get(mint)) return res.status(409).json({ error: 'already_registered' });

    const core = coreWallet().publicKey.toBase58();
    const v = await verifyToken(mint, core);
    if (!v.ok) return res.status(422).json({ error: 'verification_failed', ...v });

    const token = store.upsert(mint, {
      name: name || shortMint(mint),
      linked: linked || underlying,
      side,
      leverage: Number(leverage),
      status: 'active',
      pnl: 0,
      sizeUsd: 0,
      registeredAt: Date.now(),
      checks: v.checks,
    });
    res.json({ ok: true, token });
  } catch (e) {
    res.status(500).json({ error: 'server_error', detail: e.message });
  }
});

app.listen(CONFIG.PORT, () => {
  console.log(`[api] listening on :${CONFIG.PORT}`);
  if (process.env.RUN_ENGINE !== 'false') {
    try { startEngine(); } catch (e) { console.error('[engine] not started:', e.message); }
  }
});

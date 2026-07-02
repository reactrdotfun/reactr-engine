import express from 'express';
import cors from 'cors';
import { CONFIG } from './config.js';
import { store } from './store.js';
import { isValidMint, coreWallet } from './solana.js';
import { verifyToken } from './verify.js';
import { startEngine } from './engine.js';

const app = express();
app.use(express.json());
app.use(cors({ origin: CONFIG.CORS_ORIGIN }));

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Aggregate metrics for the site (telemetry + dashboard)
app.get('/api/v1/stats', (_req, res) => res.json(store.stats()));

// All registered tokens (dashboard grid)
app.get('/api/v1/tokens', (_req, res) => res.json(store.all()));

// One token's status + position
app.get('/api/v1/tokens/:mint/status', (req, res) => {
  const t = store.get(req.params.mint);
  if (!t) return res.status(404).json({ error: 'not_registered' });
  res.json(t);
});

// Register a token
app.post('/api/v1/tokens/register', async (req, res) => {
  try {
    const { mint, underlying = 'SOL', side = 'long', leverage = 100 } = req.body || {};
    if (!isValidMint(mint)) return res.status(400).json({ error: 'invalid_mint' });
    if (store.get(mint)) return res.status(409).json({ error: 'already_registered' });

    const core = coreWallet().publicKey.toBase58();
    const v = await verifyToken(mint, core);
    if (!v.ok) return res.status(422).json({ error: 'verification_failed', ...v });

    const token = store.upsert(mint, {
      underlying, side, leverage: Number(leverage),
      status: 'active', registeredAt: Date.now(), checks: v.checks,
    });
    res.json({ ok: true, token });
  } catch (e) {
    res.status(500).json({ error: 'server_error', detail: e.message });
  }
});

app.listen(CONFIG.PORT, () => {
  console.log(`[api] listening on :${CONFIG.PORT}`);
  // run the engine in the same process (or run `npm run worker` separately)
  if (process.env.RUN_ENGINE !== 'false') {
    try { startEngine(); } catch (e) { console.error('[engine] not started:', e.message); }
  }
});

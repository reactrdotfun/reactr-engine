// Tiny JSON-file store. Swap for Postgres/Redis in production.
// Shapes here match exactly what the reactr.fun frontend consumes.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const FILE = process.env.DATA_FILE || './data/db.json';
const empty = {
  feeCredits: {},            // mint -> lamports credited from attributed incoming fees
  lastScanSig: '',           // last processed incoming tx signature
  tokens: {},                 // mint -> { mint, name, linked, side, leverage, status, pnl, sizeUsd, registeredAt }
  positions: [],              // { mint, market, side, leverage, sizeUsd, pnl }
  history: [],                // { ts, market, side, size, result, tx }
  stats: { buybacks: 0, burnedUsd: 0, netPnlUsd: 0 },
  updatedAt: 0,
};

function load() {
  try { return existsSync(FILE) ? { ...structuredClone(empty), ...JSON.parse(readFileSync(FILE, 'utf8')) } : structuredClone(empty); }
  catch { return structuredClone(empty); }
}
let db = load();

function persist() {
  db.updatedAt = Date.now();
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(db, null, 2));
}

export const store = {
  all: () => Object.values(db.tokens),
  // --- fee attribution ledger ---
  credit(mint, lamports) {
    db.feeCredits[mint] = (db.feeCredits[mint] || 0) + Number(lamports);
    persist();
  },
  debit(mint, lamports) {
    db.feeCredits[mint] = Math.max(0, (db.feeCredits[mint] || 0) - Number(lamports));
    persist();
  },
  creditOf: (mint) => db.feeCredits?.[mint] || 0,
  credits: () => ({ ...(db.feeCredits || {}) }),
  getScanSig: () => db.lastScanSig || '',
  setScanSig(sig) { db.lastScanSig = sig; persist(); },
  get: (mint) => db.tokens[mint] || null,
  upsert(mint, data) {
    db.tokens[mint] = { pnl: 0, sizeUsd: 0, ...(db.tokens[mint] || {}), ...data, mint };
    persist();
    return db.tokens[mint];
  },

  // Frontend-shaped aggregate → { reactions, pnl, burned, buybacks }
  stats: () => ({
    reactions: Object.keys(db.tokens).length,
    pnl: db.stats.netPnlUsd || 0,
    burned: db.stats.burnedUsd || 0,
    buybacks: db.stats.buybacks || 0,
  }),

  positions: () => db.positions,
  history: () => db.history,

  // Open / update a position for a token
  setPosition(mint, pos) {
    const i = db.positions.findIndex((p) => p.mint === mint);
    if (i >= 0) db.positions[i] = { ...db.positions[i], ...pos, mint };
    else db.positions.push({ ...pos, mint });
    persist();
  },
  closePosition(mint) {
    db.positions = db.positions.filter((p) => p.mint !== mint);
    persist();
  },

  // Record a completed buyback+burn: updates global stats, token pnl, and history
  recordBurn({ mint, market, side = 'long', sizeUsd = 0, burnedUsd = 0, pnlUsd = 0, tx = '' }) {
    db.stats.buybacks = (db.stats.buybacks || 0) + 1;
    db.stats.burnedUsd = (db.stats.burnedUsd || 0) + Math.max(0, burnedUsd);
    db.stats.netPnlUsd = (db.stats.netPnlUsd || 0) + pnlUsd;
    if (mint && db.tokens[mint]) db.tokens[mint].pnl = (db.tokens[mint].pnl || 0) + pnlUsd;
    db.history.unshift({ ts: Date.now(), market, side, size: sizeUsd || burnedUsd, result: burnedUsd || pnlUsd, tx });
    db.history = db.history.slice(0, 50);
    persist();
  },
};

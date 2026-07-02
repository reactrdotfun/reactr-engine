// Tiny JSON-file store. Swap for Postgres/Redis in production.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const FILE = process.env.DATA_FILE || './data/db.json';
const empty = { tokens: {}, stats: { buybacks: 0, burnedUsd: 0, netPnlUsd: 0 }, updatedAt: 0 };

function load() {
  try { return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : structuredClone(empty); }
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
  get: (mint) => db.tokens[mint] || null,
  upsert(mint, data) { db.tokens[mint] = { ...(db.tokens[mint] || {}), ...data, mint }; persist(); return db.tokens[mint]; },
  stats: () => ({ ...db.stats, registeredTokens: Object.keys(db.tokens).length }),
  bumpStats(patch) { db.stats = { ...db.stats, ...patch }; persist(); },
};

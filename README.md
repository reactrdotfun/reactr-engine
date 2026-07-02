# REACTR Engine

The backend for [REACTR](https://reactr.fun) — an autonomous system that turns Pump.fun
creator fees into leveraged perpetual positions on Solana, then buys back and burns tokens.

100% of a registered token's creator fees flow to the **core wallet**. The engine sweeps
them, splits **70% → perps / 30% → $REACTR buyback**, harvests profits, and burns supply.

## Layout

```
src/
  server.js   Core API (the site talks to this)
  engine.js   Autonomous loop: claim fees → allocate → perp → harvest → buyback → burn
  perps.js    Perp adapter (Jupiter Perps / Flash) — WIRE THIS before enabling leverage
  jupiter.js  Jupiter swaps (buybacks)
  burn.js     Send tokens to the incinerator (permanent burn)
  verify.js   On-chain checks before a token is registered
  solana.js   RPC connection + core wallet
  store.js    JSON store (swap for Postgres in prod)
  config.js   Env config
```

## API

| Method | Endpoint                        | Purpose                         |
|--------|---------------------------------|---------------------------------|
| GET    | `/api/v1/stats`                 | Aggregate metrics (telemetry)   |
| GET    | `/api/v1/tokens`                | All registered tokens           |
| GET    | `/api/v1/tokens/:mint/status`   | One token's status + position   |
| POST   | `/api/v1/tokens/register`       | Register a token                |
| GET    | `/health`                       | Health check                    |

Point the site at it: set `CONFIG.API_BASE` in the frontend (`js/app.js`) to this
service's URL (e.g. `https://api.reactr.fun`).

## Run

```bash
cp .env.example .env      # fill in RPC_URL + CORE_WALLET_SECRET
npm install
npm start                 # API + engine in one process
# or: npm run worker      # engine only
```

## Deploy (Railway)

1. Push this repo to GitHub.
2. New Railway project → deploy from the repo.
3. Add env vars from `.env.example` (set `CORE_WALLET_SECRET` here, never in git).
4. Add a persistent volume and set `DATA_FILE=/data/db.json` (so registrations survive restarts).
5. Add your API domain and point `api.reactr.fun` at it.

## Status — what's real vs what you must finish

**Working now:** API + registration, on-chain mint checks, Jupiter buybacks, real burns,
70/30 allocation, and a safe fallback that buys back & burns directly when leverage is off.

**You must finish before it's fully live:**
1. **Perp adapter** (`src/perps.js`) — implement `openLong` / `harvest` against Jupiter Perps
   or Flash Trade, then set `ENABLE_PERPS=true`. Until then the engine runs in fallback mode
   (no leverage) — which is safe and honest to ship.
2. **Fee-config verification** (`src/verify.js`) — decode the Pump.fun fee-share account to
   confirm 100% of creator fees route to the core wallet and admin is revoked. Until wired,
   registration only checks the mint exists.
3. **Secrets** — `CORE_WALLET_SECRET` lives in env only. Use a paid RPC (Helius/QuickNode).

> Leveraged perpetuals carry real risk of total loss on adverse moves. Test on small size.
> This is experimental software; run it only with funds you can lose.

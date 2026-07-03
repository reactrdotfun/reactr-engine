import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const CONFIG = {
  RPC_URL: (process.env.RPC_URL && process.env.RPC_URL.startsWith('http')) ? process.env.RPC_URL : 'https://api.mainnet-beta.solana.com',
  CORE_WALLET_SECRET: process.env.CORE_WALLET_SECRET || '',
  REACTR_MINT: process.env.REACTR_MINT || '',
  FEE_CLAIM_THRESHOLD_SOL: num(process.env.FEE_CLAIM_THRESHOLD_SOL, 0.05),
  ALLOC_PERP_PCT: num(process.env.ALLOC_PERP_PCT, 70),
  ALLOC_REACTR_PCT: num(process.env.ALLOC_REACTR_PCT, 30),
  PROFIT_CHECK_SECONDS: num(process.env.PROFIT_CHECK_SECONDS, 75),
  LOOP_SECONDS: num(process.env.LOOP_SECONDS, 30),
  PORT: num(process.env.PORT, 8080),
  CORS_ORIGIN: (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim()),
  ENABLE_PERPS: String(process.env.ENABLE_PERPS).toLowerCase() === 'true',
  // Perp safety gates
  PERPS_LIVE: String(process.env.PERPS_LIVE).toLowerCase() === 'true', // false => simulate only
  PERPS_MAX_LEVERAGE: num(process.env.PERPS_MAX_LEVERAGE, 10),
  MAX_POSITION_USD: num(process.env.MAX_POSITION_USD, 25),
  HARVEST_PROFIT_PCT: num(process.env.HARVEST_PROFIT_PCT, 15), // close a long when unrealized >= this %
  // Sweep / withdraw mode — sells all held tokens to SOL and sends it to SWEEP_DESTINATION.
  SWEEP_MODE: String(process.env.SWEEP_MODE).toLowerCase() === 'true',
  // BURN_ENABLED=false -> engine skips ALL buyback/burn spending (REACTR + fallbacks)
  // but still runs perp attempts (dry-run or live). For testing perps in isolation.
  BURN_ENABLED: String(process.env.BURN_ENABLED ?? 'true').toLowerCase() !== 'false',
  // PERPS_TEST_SINGLE=true -> don't split the 70% across tokens; send it all as ONE
  // slice to the first active token. For testing perps with a small balance.
  PERPS_TEST_SINGLE: String(process.env.PERPS_TEST_SINGLE).toLowerCase() === 'true',
  SWEEP_DESTINATION: process.env.SWEEP_DESTINATION || '',
};

// Solana incinerator — tokens sent here are permanently burned/unrecoverable.
export const BURN_ADDRESS = '1nc1nerator11111111111111111111111111111111';

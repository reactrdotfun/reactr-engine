import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const CONFIG = {
  RPC_URL: process.env.RPC_URL || '',
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
};

// Solana incinerator — tokens sent here are permanently burned/unrecoverable.
export const BURN_ADDRESS = '1nc1nerator11111111111111111111111111111111';

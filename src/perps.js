/**
 * PERP ADAPTER — Jupiter Perpetuals (real integration, simulate-first).
 * ---------------------------------------------------------------------------
 * WHAT WORKS:
 *   - Jupiter Perps only lists SOL / ETH / wBTC. There are NO perps for memecoins
 *     (BONK/WIF/JUP/etc.) — for those markets the engine falls back to buyback+burn.
 *   - Max leverage is ~100x (not 250x). We cap at PERPS_MAX_LEVERAGE.
 *   - Positions are opened via a request the Jupiter keeper executes (not a swap).
 *
 * SAFETY MODEL (read before enabling):
 *   1. ENABLE_PERPS=false  -> adapter never runs; engine buys back & burns directly.
 *   2. ENABLE_PERPS=true + PERPS_LIVE=false (DEFAULT) -> builds the real tx and
 *      SIMULATES it on the RPC. Nothing is sent. Returns the simulation result.
 *      Use this to validate the integration against the live on-chain IDL.
 *   3. PERPS_LIVE=true -> actually sends. Only flip this after simulation passes
 *      AND you've tested with a tiny MAX_POSITION_USD on mainnet.
 *
 * The instruction encoding is built from the program's ON-CHAIN IDL (fetched at
 * runtime via Anchor), so encoding is correct-by-construction. The PDA seeds and
 * account names below match Jupiter Perps at time of writing — if a simulation
 * fails with an account/seed error, log `Object.keys(program.methods)` and the
 * IDL accounts and adjust. This is expected iteration for a live integration.
 *
 * Docs: https://station.jup.ag/guides/perpetual-exchange/onchain-accounts
 */
import { PublicKey, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import anchor from '@coral-xyz/anchor';
const { AnchorProvider, Program, BN, Wallet } = anchor;
import { CONFIG } from './config.js';
import { connection, coreWallet } from './solana.js';

export function perpsEnabled() { return CONFIG.ENABLE_PERPS; }

const PERPS_PROGRAM = new PublicKey('PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// Jupiter Perps supported markets → underlying mint (collateral is USDC).
const MARKETS = {
  SOL: new PublicKey('So11111111111111111111111111111111111111112'),
  ETH: new PublicKey('7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'), // Wormhole ETH
  BTC: new PublicKey('3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh'), // Wormhole wBTC
  WBTC: new PublicKey('3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh'),
};

const SIDE_LONG = 1; // 1 = long, 2 = short (Jupiter perps enum)

let _program = null;
let _accts = null;

async function getProgram() {
  if (_program) return _program;
  const provider = new AnchorProvider(connection, new Wallet(coreWallet()), { commitment: 'confirmed' });
  const idl = await Program.fetchIdl(PERPS_PROGRAM, provider);
  if (!idl) throw new Error('could not fetch Jupiter Perps IDL from chain');
  _program = new Program(idl, PERPS_PROGRAM, provider);
  return _program;
}

// Discover pool / perpetuals / custodies from chain instead of hardcoding addresses.
async function getAccounts() {
  if (_accts) return _accts;
  const p = await getProgram();
  const [perpetuals] = PublicKey.findProgramAddressSync([Buffer.from('perpetuals')], PERPS_PROGRAM);
  const pools = await p.account.pool.all();
  if (!pools.length) throw new Error('no Jupiter pool found');
  const pool = pools[0].publicKey; // JLP pool
  const custodies = await p.account.custody.all();
  const byMint = {};
  for (const c of custodies) byMint[c.account.mint.toBase58()] = { pubkey: c.publicKey, oracle: c.account.oracle?.oracleAccount || c.account.oracle };
  _accts = { perpetuals, pool, byMint };
  return _accts;
}

async function usdPrice(mint) {
  // Jupiter price API (public). Returns USD price for the mint.
  const r = await fetch(`https://price.jup.ag/v6/price?ids=${mint}`);
  if (!r.ok) throw new Error(`price api ${r.status}`);
  const j = await r.json();
  const price = j?.data?.[mint]?.price;
  if (!price) throw new Error('no price for ' + mint);
  return price;
}

function marketMint(sym) {
  const m = MARKETS[String(sym).toUpperCase()];
  return m || null;
}

async function buildAndRun(ixs, label) {
  const wallet = coreWallet();
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), ...ixs],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([wallet]);

  // SIMULATE-FIRST gate — nothing is sent unless PERPS_LIVE=true.
  if (!CONFIG.PERPS_LIVE) {
    const sim = await connection.simulateTransaction(tx, { sigVerify: false });
    if (sim.value.err) {
      console.error(`[perps:sim] ${label} FAILED`, JSON.stringify(sim.value.err), sim.value.logs?.slice(-6));
      throw new Error(`perps simulation failed (${label}) — see logs`);
    }
    console.log(`[perps:sim] ${label} OK (dry run — set PERPS_LIVE=true to fire)`);
    return { sig: null, simulated: true };
  }

  const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  await connection.confirmTransaction(sig, 'confirmed');
  return { sig, simulated: false };
}

/**
 * Open a leveraged long. Returns { sig|null, positionId, simulated }.
 * Throws for unsupported markets so the engine can fall back to buyback.
 */
export async function openLong({ market, collateralLamports, leverage }) {
  const mint = marketMint(market);
  if (!mint) throw new Error(`market ${market} not tradable on Jupiter Perps (SOL/ETH/BTC only) — fallback`);

  const lev = Math.min(Number(leverage) || 2, CONFIG.PERPS_MAX_LEVERAGE);
  const wallet = coreWallet();
  const p = await getProgram();
  const { perpetuals, pool, byMint } = await getAccounts();

  const custody = byMint[mint.toBase58()];
  const collateralCustody = byMint[USDC_MINT.toBase58()];
  if (!custody || !collateralCustody) throw new Error('custody not found for market/collateral — fallback');

  // Size the position in USD, capped by MAX_POSITION_USD.
  const solUsd = await usdPrice(MARKETS.SOL.toBase58());
  const collateralUsd = Math.min((collateralLamports / 1e9) * solUsd, CONFIG.MAX_POSITION_USD);
  if (collateralUsd < 10) throw new Error('collateral below $10 min — fallback');
  const sizeUsd = collateralUsd * lev;

  // 6-decimal USD fixed point used by the program.
  const sizeUsdDelta = new BN(Math.floor(sizeUsd * 1e6));
  const collateralUsdc = new BN(Math.floor(collateralUsd * 1e6)); // USDC has 6 decimals

  const [position] = PublicKey.findProgramAddressSync(
    [Buffer.from('position'), wallet.publicKey.toBuffer(), pool.toBuffer(), custody.pubkey.toBuffer(), collateralCustody.pubkey.toBuffer(), Buffer.from([SIDE_LONG])],
    PERPS_PROGRAM,
  );
  const counter = new BN(Date.now());
  const [positionRequest] = PublicKey.findProgramAddressSync(
    [Buffer.from('position_request'), position.toBuffer(), counter.toArrayLike(Buffer, 'le', 8), Buffer.from([1])],
    PERPS_PROGRAM,
  );
  const positionRequestAta = getAssociatedTokenAddressSync(USDC_MINT, positionRequest, true);
  const fundingAccount = getAssociatedTokenAddressSync(USDC_MINT, wallet.publicKey);
  const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PERPS_PROGRAM);

  const ix = await p.methods
    .createIncreasePositionMarketRequest({
      sizeUsdDelta,
      collateralTokenDelta: collateralUsdc,
      side: SIDE_LONG,
      priceSlippage: new BN(0),
      jupiterMinimumOut: null,
      counter,
    })
    .accounts({
      owner: wallet.publicKey,
      fundingAccount,
      perpetuals,
      pool,
      position,
      positionRequest,
      positionRequestAta,
      custody: custody.pubkey,
      collateralCustody: collateralCustody.pubkey,
      inputMint: USDC_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: PublicKey.default,
      eventAuthority,
      program: PERPS_PROGRAM,
    })
    .instruction();

  const res = await buildAndRun([ix], `openLong ${market} ${lev}x $${sizeUsd.toFixed(0)}`);
  return { ...res, positionId: position.toBase58(), sizeUsd, leverage: lev };
}

/**
 * Unrealized price move % for a long position (leverage amplifies actual PnL).
 * Field names assume Jupiter Perps' position layout — verify against the live IDL.
 * Returns null if it can't be read (engine then leaves the position open).
 */
export async function unrealizedPct(positionId) {
  const p = await getProgram();
  const pos = await p.account.position.fetch(new PublicKey(positionId)).catch(() => null);
  if (!pos || !pos.sizeUsd || pos.sizeUsd.isZero?.()) return null;
  const { byMint } = await getAccounts();
  let mktMint = null;
  for (const [mintStr, c] of Object.entries(byMint)) if (c.pubkey.equals(pos.custody)) mktMint = mintStr;
  if (!mktMint) return null;
  const entry = Number(pos.price) / 1e6; // entry price, 6dp
  if (!entry) return null;
  const cur = await usdPrice(mktMint);
  return ((cur - entry) / entry) * 100; // price move %; long
}

/**
 * Close / harvest a position by its PDA (positionId from openLong).
 * Builds a full-size decrease request. Returns { sig|null, simulated }.
 */
export async function harvest(positionId) {
  const wallet = coreWallet();
  const p = await getProgram();
  const { perpetuals, pool } = await getAccounts();
  const position = new PublicKey(positionId);
  const pos = await p.account.position.fetch(position).catch(() => null);
  if (!pos) throw new Error('position not found (already closed?)');

  const counter = new BN(Date.now());
  const [positionRequest] = PublicKey.findProgramAddressSync(
    [Buffer.from('position_request'), position.toBuffer(), counter.toArrayLike(Buffer, 'le', 8), Buffer.from([2])],
    PERPS_PROGRAM,
  );
  const desiredMint = USDC_MINT;
  const positionRequestAta = getAssociatedTokenAddressSync(desiredMint, positionRequest, true);
  const receivingAccount = getAssociatedTokenAddressSync(desiredMint, wallet.publicKey);
  const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PERPS_PROGRAM);

  const ix = await p.methods
    .createDecreasePositionMarketRequest({
      collateralUsdDelta: new BN(0),
      sizeUsdDelta: pos.sizeUsd, // full close
      priceSlippage: new BN(0),
      jupiterMinimumOut: null,
      entirePosition: true,
      counter,
    })
    .accounts({
      owner: wallet.publicKey,
      receivingAccount,
      perpetuals,
      pool,
      position,
      positionRequest,
      positionRequestAta,
      custody: pos.custody,
      collateralCustody: pos.collateralCustody,
      desiredMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: PublicKey.default,
      eventAuthority,
      program: PERPS_PROGRAM,
    })
    .instruction();

  return buildAndRun([ix], `harvest ${positionId.slice(0, 6)}`);
}

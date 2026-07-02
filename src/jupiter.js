// Jupiter swap helpers — used for buybacks. Public API, no key required.
// Docs: https://station.jup.ag/docs/apis/swap-api
import { VersionedTransaction, PublicKey } from '@solana/web3.js';
import { connection, coreWallet } from './solana.js';

const JUP = 'https://quote-api.jup.ag/v6';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

export async function getQuote(inputMint, outputMint, amount, slippageBps = 300) {
  const url = `${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`jupiter quote ${r.status}`);
  return r.json();
}

// Swaps `amountLamports` of SOL into `outputMint`, signed by the core wallet.
export async function buyToken(outputMint, amountLamports, slippageBps = 300) {
  const wallet = coreWallet();
  const quote = await getQuote(SOL_MINT, outputMint, amountLamports, slippageBps);

  const r = await fetch(`${JUP}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });
  if (!r.ok) throw new Error(`jupiter swap ${r.status}`);
  const { swapTransaction } = await r.json();

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([wallet]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  await connection.confirmTransaction(sig, 'confirmed');
  return { sig, outAmount: quote.outAmount };
}

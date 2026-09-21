import type { ClobClient } from "@polymarket/clob-client";

// Fee rate is per-market (both YES/NO tokens share it) and doesn't change
// within a run, so it's cached indefinitely per token id to avoid refetching
// on every orderbook update.
const cache = new Map<string, number>();

async function getFeeRateBps(client: ClobClient, tokenId: string): Promise<number> {
  const cached = cache.get(tokenId);
  if (cached !== undefined) return cached;
  const bps = await client.getFeeRateBps(tokenId);
  cache.set(tokenId, bps);
  return bps;
}

// Taker fee per Polymarket's fee schedule: fee = shares * feeRate * p * (1-p),
// charged on both legs since both are taker market orders. Returns the net
// margin per share after subtracting the expected fee from the raw
// (yesAsk + noAsk) spread.
export async function computeNetMargin(
  client: ClobClient,
  yesTokenId: string,
  noTokenId: string,
  yesAsk: number,
  noAsk: number
): Promise<number> {
  const feeRateBps = await getFeeRateBps(client, yesTokenId);
  const feeRate = feeRateBps / 10_000;
  const feePerShare = feeRate * (yesAsk * (1 - yesAsk) + noAsk * (1 - noAsk));
  const rawMargin = 1 - (yesAsk + noAsk);
  return rawMargin - feePerShare;
}

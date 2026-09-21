import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { config } from "./config.js";
import { fetchActiveMarkets } from "./markets.js";
import { OrderbookStore } from "./orderbookStore.js";
import { executeArb, sizeOpportunity } from "./executor.js";
import { assertTradingReady } from "./preflight.js";
import { logger } from "./logger.js";

interface MarketInfo {
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
}

// Realtime scan: subscribes to live orderbooks via WebSocket and reacts to
// the within-market arb condition (YES ask + NO ask < 1) on every book
// update, instead of polling REST on an interval. Trading is gated by
// config.enableTrading — off by default, so this dry-runs until explicitly
// enabled in .env.
async function main() {
  const wallet = new Wallet(config.privateKey);
  const client = new ClobClient(config.clobApiUrl, 137, wallet, {
    key: config.clobApiKey,
    secret: config.clobApiSecret,
    passphrase: config.clobApiPassphrase,
  });

  await assertTradingReady(client);

  const markets = await fetchActiveMarkets();
  logger.info(`Loaded ${markets.length} active markets, subscribing to orderbooks...`);

  const byTokenId = new Map<string, MarketInfo>();
  const tokenIds: string[] = [];

  for (const m of markets) {
    const [yesTokenId, noTokenId] = JSON.parse(m.clobTokenIds) as [string, string];
    const info: MarketInfo = { conditionId: m.conditionId, question: m.question, yesTokenId, noTokenId };
    byTokenId.set(yesTokenId, info);
    byTokenId.set(noTokenId, info);
    tokenIds.push(yesTokenId, noTokenId);
  }

  // Guards against re-entering executeArb for the same market while a
  // previous attempt on it is still in flight.
  const inFlight = new Set<string>();

  const store = new OrderbookStore(tokenIds, (updatedTokenId) => {
    const info = byTokenId.get(updatedTokenId);
    if (!info || inFlight.has(info.conditionId)) return;

    const yesAsk = store.getBestAsk(info.yesTokenId);
    const noAsk = store.getBestAsk(info.noTokenId);
    if (yesAsk == null || noAsk == null) return;

    const margin = 1 - (yesAsk + noAsk);
    if (margin <= config.minProfitMargin) return;

    const yesBook = store.getBook(info.yesTokenId);
    const noBook = store.getBook(info.noTokenId);
    if (!yesBook || !noBook) return;

    const opp = { ...info, yesAsk, noAsk, margin };
    const shares = sizeOpportunity(opp, yesBook, noBook);

    logger.info(`[ARB] ${info.question} | YES=${yesAsk} NO=${noAsk} margin=${margin.toFixed(4)} shares=${shares.toFixed(2)}`);

    inFlight.add(info.conditionId);
    executeArb(client, opp, shares)
      .catch((err) => logger.error("executeArb threw", { question: info.question, err }))
      .finally(() => inFlight.delete(info.conditionId));
  });

  store.connect();
}

main().catch((err) => {
  logger.error("Fatal error in scan", err);
  process.exit(1);
});

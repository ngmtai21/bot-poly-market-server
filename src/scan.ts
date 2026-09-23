import { ClobClient } from "@polymarket/clob-client";
import { createSigner } from "./signer.js";
import { config } from "./config.js";
import { fetchActiveMarkets } from "./markets.js";
import { OrderbookStore } from "./orderbookStore.js";
import { executeArb, sizeOpportunity } from "./executor.js";
import { assertTradingReady } from "./preflight.js";
import { computeNetMargin } from "./feeRate.js";
import { logger } from "./logger.js";

interface MarketInfo {
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  liquidityNum?: number;
  volumeNum?: number;
}

// Realtime scan: subscribes to live orderbooks via WebSocket and reacts to
// the within-market arb condition (YES ask + NO ask < 1) on every book
// update, instead of polling REST on an interval. Trading is gated by
// config.enableTrading — off by default, so this dry-runs until explicitly
// enabled in .env.
async function main() {
  const signer = createSigner(config.privateKey);
  const client = new ClobClient(config.clobApiUrl, 137, signer, {
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
    const info: MarketInfo = {
      conditionId: m.conditionId,
      question: m.question,
      yesTokenId,
      noTokenId,
      liquidityNum: m.liquidityNum,
      volumeNum: m.volumeNum,
    };
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

    // Cheap pre-filter before the fee-rate lookup: skip anything that isn't
    // even profitable before fees.
    const rawMargin = 1 - (yesAsk + noAsk);
    if (rawMargin <= 0) return;

    inFlight.add(info.conditionId);
    computeNetMargin(client, info.yesTokenId, info.noTokenId, yesAsk, noAsk)
      .then((margin) => {
        if (margin <= config.minProfitMargin) return;

        const yesBook = store.getBook(info.yesTokenId);
        const noBook = store.getBook(info.noTokenId);
        if (!yesBook || !noBook) return;

        const opp = { ...info, yesAsk, noAsk, margin };
        const shares = sizeOpportunity(opp, yesBook, noBook);

        logger.info(
          `[ARB] ${info.question} | YES=${yesAsk} NO=${noAsk} netMargin=${margin.toFixed(4)} shares=${shares.toFixed(2)}`
        );

        return executeArb(client, opp, shares);
      })
      .catch((err) => logger.error("Opportunity handling threw", { question: info.question, err }))
      .finally(() => inFlight.delete(info.conditionId));
  });

  store.connect();
}

main().catch((err) => {
  logger.error("Fatal error in scan", err);
  process.exit(1);
});

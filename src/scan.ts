import { config } from "./config.js";
import { fetchActiveMarkets } from "./markets.js";
import { OrderbookStore } from "./orderbookStore.js";

interface MarketInfo {
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
}

// Realtime scan: subscribes to live orderbooks via WebSocket and checks the
// within-market arb condition (YES ask + NO ask < 1) on every book update,
// instead of polling REST on an interval. Read-only — logs only, no orders.
async function main() {
  const markets = await fetchActiveMarkets();
  console.log(`Loaded ${markets.length} active markets, subscribing to orderbooks...`);

  const byTokenId = new Map<string, MarketInfo>();
  const tokenIds: string[] = [];

  for (const m of markets) {
    const [yesTokenId, noTokenId] = JSON.parse(m.clobTokenIds) as [string, string];
    const info: MarketInfo = { conditionId: m.conditionId, question: m.question, yesTokenId, noTokenId };
    byTokenId.set(yesTokenId, info);
    byTokenId.set(noTokenId, info);
    tokenIds.push(yesTokenId, noTokenId);
  }

  const store = new OrderbookStore(tokenIds, (updatedTokenId) => {
    const info = byTokenId.get(updatedTokenId);
    if (!info) return;

    const yesAsk = store.getBestAsk(info.yesTokenId);
    const noAsk = store.getBestAsk(info.noTokenId);
    if (yesAsk == null || noAsk == null) return;

    const margin = 1 - (yesAsk + noAsk);
    if (margin > config.minProfitMargin) {
      console.log(
        `[ARB] ${info.question} | YES=${yesAsk} NO=${noAsk} margin=${margin.toFixed(4)} @ ${new Date().toISOString()}`
      );
    }
  });

  store.connect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

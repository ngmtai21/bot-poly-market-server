import { ClobClient, Side } from "@polymarket/clob-client";
import { createSigner } from "./signer.js";
import { config } from "./config.js";
import { fetchActiveMarkets } from "./markets.js";
import { OrderbookStore } from "./orderbookStore.js";
import { executeArb, sizeOpportunity } from "./executor.js";
import { assertTradingReady } from "./preflight.js";
import { computeNetMargin } from "./feeRate.js";
import { openDb } from "./db.js";
import { applySavedSettings, startControlLoop } from "./control.js";
import { consumeStagedPrivateKey } from "./walletKeyRotation.js";
import { logger } from "./logger.js";

const SNAPSHOT_BATCH = 500; // measured: POST /books accepts 500 ids, fails at 1000
const RESYNC_INTERVAL_MS = 10 * 60_000;

// Full REST snapshots for every token: the WS sends almost none for large
// subscriptions, and deltas alone can drift. Runs on every (re)connect and
// periodically; overlapping runs are skipped.
function snapshotLoader(client: ClobClient, store: OrderbookStore, tokenIds: string[]) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    const start = Date.now();
    let loaded = 0;
    try {
      for (let i = 0; i < tokenIds.length; i += SNAPSHOT_BATCH) {
        // `side` is required by the SDK's shared BookParams type; /books returns both sides regardless.
        const batch = tokenIds.slice(i, i + SNAPSHOT_BATCH).map((token_id) => ({ token_id, side: Side.BUY }));
        try {
          for (const b of await client.getOrderBooks(batch)) {
            store.applySnapshot(b.asset_id, b.bids, b.asks, b.min_order_size);
            loaded++;
          }
        } catch (err) {
          logger.warn(`Snapshot batch at ${i} failed`, err instanceof Error ? err.message : err);
        }
      }
      logger.info(`Loaded ${loaded}/${tokenIds.length} orderbook snapshots in ${Date.now() - start}ms`);
    } finally {
      running = false;
    }
  };
}

interface MarketInfo {
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  liquidityNum?: number;
  volumeNum?: number;
  negRisk?: boolean;
}

// Realtime scan: subscribes to live orderbooks via WebSocket and reacts to
// the within-market arb condition (YES ask + NO ask < 1) on every book
// update, instead of polling REST on an interval. Trading is gated by
// config.enableTrading — off by default, so this dry-runs until explicitly
// enabled in .env or from the admin panel.
async function main() {
  const db = openDb(config.dbPath);
  applySavedSettings(db);

  const privateKey = consumeStagedPrivateKey(db, process.env.WALLET_KEY_DECRYPT_PRIVATE_KEY) ?? config.privateKey;
  if (!privateKey) {
    throw new Error(
      "No wallet key available — set PRIVATE_KEY in .env, or stage one from the admin panel (see README 'Rotating the wallet key')."
    );
  }
  const signer = createSigner(privateKey);
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
      negRisk: m.negRisk,
    };
    byTokenId.set(yesTokenId, info);
    byTokenId.set(noTokenId, info);
    tokenIds.push(yesTokenId, noTokenId);
  }

  // Guards against re-entering executeArb for the same market while a
  // previous attempt on it is still in flight.
  const inFlight = new Set<string>();
  let bookUpdates = 0;

  const store = new OrderbookStore(tokenIds, (updatedTokenId) => {
    bookUpdates++;
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

        return executeArb(client, db, opp, shares);
      })
      .catch((err) => logger.error("Opportunity handling threw", { question: info.question, err }))
      .finally(() => inFlight.delete(info.conditionId));
  }, () => void loadSnapshots());

  const loadSnapshots = snapshotLoader(client, store, tokenIds);
  store.connect();
  setInterval(() => void loadSnapshots(), RESYNC_INTERVAL_MS);

  const startedAt = new Date().toISOString();
  startControlLoop({
    db,
    client,
    signer,
    status: () => ({
      startedAt,
      marketsLoaded: markets.length,
      wsConnected: store.isConnected(),
      bookUpdates,
      booksSynced: store.syncedCount(),
      tokensSubscribed: tokenIds.length,
      walletAddress: signer.account!.address,
      redeemConfigured: Boolean(config.ctfAdapterAddress && config.negRiskCtfAdapterAddress && config.collateralTokenAddress),
    }),
  });
}

main().catch((err) => {
  logger.error("Fatal error in scan", err);
  process.exit(1);
});

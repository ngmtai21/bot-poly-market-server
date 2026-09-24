import assert from "node:assert/strict";
import type { ClobClient } from "@polymarket/clob-client";
import { computeNetMargin } from "../feeRate.js";
import { sizeOpportunity, isExecutable, type ArbOpportunity } from "../executor.js";
import { config } from "../config.js";
import type { Book } from "../orderbookStore.js";
import { openDb, recordOpportunity, recordTrade, summarize } from "../db.js";
import { validateCommand } from "../commands.js";

// Exercises the detection/sizing logic against synthetic orderbook data —
// no live WebSocket, no waiting for real opportunities. This is a substitute
// for a historical backtest (which isn't possible; see README) to verify the
// pipeline's math is correct, not to measure real-world profitability.
function fakeClient(feeRateBps: number): ClobClient {
  return { getFeeRateBps: async () => feeRateBps } as unknown as ClobClient;
}

function book(asks: [number, number][], minOrderSize = 0): Book {
  return { bids: [], asks: asks.map(([price, size]) => ({ price, size })), minOrderSize };
}

async function testNetMarginSubtractsFee() {
  // yesAsk=0.48, noAsk=0.50 -> raw margin = 0.02. feeRate 5% (500 bps).
  // feePerShare = 0.05 * (0.48*0.52 + 0.50*0.50) = 0.05 * (0.2496 + 0.25) = 0.02498
  // Uses its own token ids — computeNetMargin caches fee rate per token id
  // (real markets never change fee rate mid-run), so reusing an id across
  // test cases with different fee rates would read stale cached values.
  const client = fakeClient(500);
  const margin = await computeNetMargin(client, "yesTok-fee5pct", "noTok-fee5pct", 0.48, 0.5);
  assert.ok(Math.abs(margin - (0.02 - 0.02498)) < 1e-9, `expected ~-0.00498, got ${margin}`);
  assert.ok(margin < 0, "high fee near p=0.5 should turn a small raw margin negative");
}

async function testNetMarginZeroFeeMarket() {
  // Geopolitics category: feeRate 0. Net margin should equal raw margin exactly.
  const client = fakeClient(0);
  const margin = await computeNetMargin(client, "yesTok-fee0pct", "noTok-fee0pct", 0.4, 0.5);
  assert.ok(Math.abs(margin - 0.1) < 1e-9, `expected ~0.1, got ${margin}`);
}

function testSizeOpportunityCapsToDepth() {
  const opp: ArbOpportunity = {
    conditionId: "c1",
    question: "test",
    yesTokenId: "y",
    noTokenId: "n",
    yesAsk: 0.4,
    noAsk: 0.5,
    margin: 0.1,
  };
  // yesDepth=10, noDepth=5 -> capped at 5 (smaller leg), well under budget.
  const shares = sizeOpportunity(opp, book([[0.4, 10]]), book([[0.5, 5]]));
  assert.equal(shares, 5);
}

function testSizeOpportunityCapsToBudget() {
  const opp: ArbOpportunity = {
    conditionId: "c1",
    question: "test",
    yesTokenId: "y",
    noTokenId: "n",
    yesAsk: 0.4,
    noAsk: 0.5,
    margin: 0.1,
  };
  // Plenty of depth on both legs, but config.maxOrderSizeUsdc (env default 50)
  // / (0.4+0.5) = ~55.5 shares should be the binding constraint.
  const shares = sizeOpportunity(opp, book([[0.4, 1000]]), book([[0.5, 1000]]));
  assert.ok(shares < 1000, "should be capped by budget, not raw depth");
}

function testSizeOpportunityRejectsBelowMinOrderSize() {
  const opp: ArbOpportunity = {
    conditionId: "c1",
    question: "test",
    yesTokenId: "y",
    noTokenId: "n",
    yesAsk: 0.4,
    noAsk: 0.5,
    margin: 0.1,
  };
  // Only 2 shares of depth, but the market requires a 5-share minimum order.
  const shares = sizeOpportunity(opp, book([[0.4, 2]], 5), book([[0.5, 2]], 5));
  assert.equal(shares, 0, "should refuse to size an order below the exchange minimum");
}

function testIsExecutableTwoTierThreshold() {
  // config.executeMarginThreshold (env default 0.05) is the higher "worth
  // trading" bar, separate from the lower "worth logging" MIN_PROFIT_MARGIN.
  assert.equal(isExecutable(config.executeMarginThreshold - 0.001), false, "just below threshold should not execute");
  assert.equal(isExecutable(config.executeMarginThreshold), true, "exactly at threshold should execute");
  assert.equal(isExecutable(config.executeMarginThreshold + 0.01), true, "above threshold should execute");
}

function testLedgerAndSummary() {
  const db = openDb(":memory:");
  const base = { conditionId: "0xc1", question: "q", yesAsk: 0.4, noAsk: 0.5, margin: 0.1, negRisk: false };
  recordOpportunity(db, { ...base, shares: 10, reason: "dry-run" });
  recordOpportunity(db, { ...base, shares: 0, reason: "unsizeable" });
  recordTrade(db, { ...base, shares: 10, yesSpend: 4, noSpend: 5, status: "filled" });
  recordTrade(db, { ...base, shares: 5, yesSpend: 2, noSpend: 2.5, status: "filled" }); // same market: accumulates
  recordTrade(db, { ...base, shares: 10, yesSpend: 4, noSpend: 5, status: "both_failed" }); // no position

  const s = summarize(db);
  assert.equal(s.opportunities.total, 2);
  assert.equal(s.opportunities.sizeable, 1);
  assert.ok(Math.abs(Number(s.opportunities.hypotheticalProfit) - 1) < 1e-9, "only sizeable rows count toward profit");
  assert.equal(s.trades.byStatus.filled, 2);
  assert.equal(s.openPositions.count, 1, "two fills in one market = one position");
  assert.ok(Math.abs(s.openPositions.lockedCapital - 13.5) < 1e-9);
  assert.equal(s.openPositions.expectedPayout, 15, "payout = shares (one leg pays $1/share)");
}

function testValidateCommand() {
  assert.deepEqual(validateCommand("pause", undefined), { type: "pause", payload: {} });
  assert.throws(() => validateCommand("set_config", { maxOrderSizeUsdc: 50000 }), /maxOrderSizeUsdc/);
  assert.throws(() => validateCommand("set_config", { minProfitMargin: 5 }), /minProfitMargin/, "5 means 500%, reject");
  assert.throws(() => validateCommand("set_config", { enableTrading: "true" }), /enableTrading/, "string 'true' is not a boolean");
  assert.throws(() => validateCommand("set_config", {}), /at least one/);
  assert.throws(() => validateCommand("redeem", { conditionId: "0x123", negRisk: false }), /conditionId/);
  assert.throws(() => validateCommand("drop_tables", {}), /unknown command/);
}

async function main() {
  const tests: [string, () => void | Promise<void>][] = [
    ["ledger: fills open/accumulate positions, summary math", testLedgerAndSummary],
    ["validateCommand rejects unsafe/malformed input", testValidateCommand],
    ["net margin subtracts fee correctly", testNetMarginSubtractsFee],
    ["net margin equals raw margin at 0% fee", testNetMarginZeroFeeMarket],
    ["sizeOpportunity caps to smaller leg's depth", testSizeOpportunityCapsToDepth],
    ["sizeOpportunity caps to MAX_ORDER_SIZE_USDC budget", testSizeOpportunityCapsToBudget],
    ["sizeOpportunity rejects orders below min_order_size", testSizeOpportunityRejectsBelowMinOrderSize],
    ["isExecutable enforces the two-tier margin threshold", testIsExecutableTwoTierThreshold],
  ];

  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL  ${name}`);
      console.error(err);
    }
  }

  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
}

main();

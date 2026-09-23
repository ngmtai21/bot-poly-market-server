import assert from "node:assert/strict";
import type { ClobClient } from "@polymarket/clob-client";
import { computeNetMargin } from "../feeRate.js";
import { sizeOpportunity, isExecutable, type ArbOpportunity } from "../executor.js";
import { config } from "../config.js";
import type { Book } from "../orderbookStore.js";

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

async function main() {
  const tests: [string, () => void | Promise<void>][] = [
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

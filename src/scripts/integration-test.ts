import assert from "node:assert/strict";
import { ClobClient, Side } from "@polymarket/clob-client";
import { config } from "../config.js";
import { createSigner } from "../signer.js";
import { fetchActiveMarkets } from "../markets.js";

// Exercises real network paths that self-test.ts can't: live Gamma API,
// live CLOB REST endpoints, and — most importantly — local EIP-712 order
// signing via the viem signer. Signing is never exercised by dry-run scans
// (executeArb's dry-run branch returns before signing anything), so this is
// the only way to know the signer actually works before a live opportunity
// forces the first real signature. No orders are submitted; createOrder()
// signs locally and returns without hitting the API.
async function main() {
  const signer = createSigner(config.privateKey);
  const client = new ClobClient(config.clobApiUrl, 137, signer);

  console.log("1. Fetching active markets from Gamma API...");
  const markets = await fetchActiveMarkets();
  assert.ok(markets.length > 0, "expected at least one active market");
  const [market] = markets;
  const [yesTokenId] = JSON.parse(market.clobTokenIds) as [string, string];
  console.log(`   OK — ${markets.length} markets, using "${market.question}" for the rest`);

  console.log("2. Fetching live orderbook via REST...");
  const book = await client.getOrderBook(yesTokenId);
  assert.ok(Array.isArray(book.asks), "orderbook should have an asks array");
  assert.ok("min_order_size" in book, "orderbook should expose min_order_size");
  console.log(`   OK — min_order_size=${book.min_order_size}, tick_size=${book.tick_size}, ${book.asks.length} ask levels`);

  console.log("3. Fetching real fee rate...");
  const feeRateBps = await client.getFeeRateBps(yesTokenId);
  assert.equal(typeof feeRateBps, "number");
  console.log(`   OK — feeRateBps=${feeRateBps} (${(feeRateBps / 100).toFixed(2)}%)`);

  console.log("4. Signing a test order locally (not submitted)...");
  const tickSize = await client.getTickSize(yesTokenId);
  const signed = await client.createOrder({
    tokenID: yesTokenId,
    price: Number(tickSize),
    size: 5,
    side: Side.BUY,
  });
  assert.ok(signed.signature && signed.signature.length > 0, "expected a non-empty signature");
  console.log(`   OK — signed order, signature length=${signed.signature.length}`);

  console.log("\nAll integration checks passed. Signer, network, and API surface are verified working.");
}

main().catch((err) => {
  console.error("\nIntegration check FAILED:");
  console.error(err);
  process.exit(1);
});

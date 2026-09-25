import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { DEFAULT_DB_PATH, openDb, summarize } from "../db.js";

loadDotenv({ path: ".env.admin", quiet: true }); // DB_PATH lives in the admin env

// Summarizes everything the bot has recorded: opportunity counts by reason,
// average margin, hypothetical profit, real trade outcomes, open positions.
// Same numbers the admin dashboard shows (both call summarize()).
function main() {
  const path = process.env.DB_PATH ?? DEFAULT_DB_PATH;
  if (!existsSync(path)) {
    console.log(`No database at "${path}" yet — start the bot with \`npm run scan\` first.`);
    return;
  }

  const s = summarize(openDb(path));
  const o = s.opportunities;
  if (!o.total) {
    console.log("No opportunities logged yet. Normal if the bot started recently — let it run longer (ideally 24h+).");
    return;
  }

  const pct = (v: unknown) => `${((Number(v) || 0) * 100).toFixed(2)}%`;
  const usd = (v: unknown) => `$${(Number(v) || 0).toFixed(2)}`;

  console.log(`Period: ${o.firstTs} -> ${o.lastTs}`);
  console.log(`Opportunities logged: ${o.total} (sizeable: ${o.sizeable ?? 0})`);
  console.log(`By reason: ${JSON.stringify(o.byReason)}`);
  console.log(`Average net margin: ${pct(o.avgMargin)}`);
  console.log(`Hypothetical profit (sizeable only): ${usd(o.hypotheticalProfit)}`);
  if (o.avgLiquidity != null) {
    console.log(`Market liquidity of opportunities — avg: ${usd(o.avgLiquidity)}, median: ${usd(o.medianLiquidity)}`);
  }
  console.log(`\nReal trades by status: ${JSON.stringify(s.trades.byStatus)}`);
  console.log(`Filled: cost ${usd(s.trades.filledCost)}, expected profit ${usd(s.trades.filledExpectedProfit)}`);
  console.log(
    `Open positions: ${s.openPositions.count}, locked capital ${usd(s.openPositions.lockedCapital)}, expected payout ${usd(s.openPositions.expectedPayout)}`
  );
}

main();

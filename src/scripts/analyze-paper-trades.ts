import { readFileSync } from "node:fs";

// Summarizes paper-trades.jsonl: how many dry-run opportunities were logged,
// their average margin/size, and total hypothetical profit. Run after
// letting `npm run scan` dry-run for a while to decide whether real trading
// is worth enabling.
function main() {
  const path = process.argv[2] ?? "paper-trades.jsonl";
  const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
  const trades = lines.map((l) => JSON.parse(l));

  if (trades.length === 0) {
    console.log("No paper trades logged yet.");
    return;
  }

  const sizeable = trades.filter((t) => t.shares > 0);
  const totalProfit = sizeable.reduce((sum, t) => sum + t.expectedProfitUsdc, 0);
  const avgMargin = trades.reduce((sum, t) => sum + t.margin, 0) / trades.length;
  const first = trades[0].ts;
  const last = trades[trades.length - 1].ts;

  console.log(`Period: ${first} -> ${last}`);
  console.log(`Total opportunities logged: ${trades.length}`);
  console.log(`Sizeable (shares > 0): ${sizeable.length}`);
  console.log(`Average margin: ${(avgMargin * 100).toFixed(2)}%`);
  console.log(`Total hypothetical profit: $${totalProfit.toFixed(2)}`);
}

main();

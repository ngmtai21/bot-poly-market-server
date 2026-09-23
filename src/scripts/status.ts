import { existsSync, readFileSync } from "node:fs";

// Quick sanity check: is the bot alive and how many opportunities has it
// logged so far. Run this instead of `npm run analyze` when you just want
// to know "is this working" without confusing "no data yet" with an error.
function main() {
  const path = "paper-trades.jsonl";

  if (!existsSync(path)) {
    console.log("No opportunities logged yet — this is normal if the bot started recently.");
    console.log("Check `pm2 logs polymarket-bot --lines 50 --nostream` for a recent");
    console.log('"Loaded N active markets..." line with no errors below it to confirm it\'s running.');
    return;
  }

  const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
  const trades = lines.map((l) => JSON.parse(l));
  const last = trades[trades.length - 1];

  console.log(`${trades.length} opportunities logged so far.`);
  console.log(`Most recent: ${last.ts} — ${last.question} (margin ${(last.margin * 100).toFixed(2)}%)`);
}

main();

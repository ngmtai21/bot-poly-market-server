import { appendFileSync } from "node:fs";

const LOG_PATH = "paper-trades.jsonl";

// Appends one JSON line per dry-run opportunity, so paper-trading data
// survives across restarts and can be analyzed later (frequency, average
// margin, how many would have been sizeable). Only used when
// config.enableTrading is false — real trades are logged via logger only.
export function recordPaperTrade(entry: Record<string, unknown>): void {
  appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

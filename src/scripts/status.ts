import "dotenv/config";
import { existsSync } from "node:fs";
import { DEFAULT_DB_PATH, getKv, openDb } from "../db.js";

// Quick "is the bot alive and has it seen anything" check, from the status
// heartbeat the bot writes to SQLite every 5s.
function main() {
  const path = process.env.DB_PATH ?? DEFAULT_DB_PATH;
  if (!existsSync(path)) {
    console.log(`No database at "${path}" yet — the bot hasn't started (npm run scan).`);
    return;
  }

  const db = openDb(path);
  const status = getKv<Record<string, unknown>>(db, "status");
  if (!status) {
    console.log("Bot has never written a heartbeat — it may still be loading markets.");
    return;
  }

  const ageSec = Math.round((Date.now() - Date.parse(String(status.heartbeat))) / 1000);
  console.log(`Bot ${ageSec < 15 ? "ONLINE" : `OFFLINE (last heartbeat ${ageSec}s ago)`}`);
  console.log(
    `Mode: ${status.enableTrading ? "LIVE" : "DRY-RUN"}${status.paused ? " (PAUSED)" : ""} | markets: ${status.marketsLoaded} | WS: ${status.wsConnected ? "connected" : "down"} | book updates: ${status.bookUpdates}`
  );

  const last = db.prepare(`SELECT ts, question, margin, reason FROM opportunities ORDER BY id DESC LIMIT 1`).get() as
    | { ts: string; question: string; margin: number; reason: string }
    | undefined;
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM opportunities`).get() as { n: number };
  console.log(`${n} opportunities logged so far.`);
  if (last) console.log(`Most recent: ${last.ts} — ${last.question} (margin ${(last.margin * 100).toFixed(2)}%, ${last.reason})`);
}

main();

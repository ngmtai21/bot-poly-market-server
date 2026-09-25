import { config as loadDotenv } from "dotenv";
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { DEFAULT_DB_PATH, openDb } from "../db.js";

loadDotenv({ path: ".env.bot", quiet: true }); // DB_PATH/BACKUP_* live in the bot env

// Point-in-time backup of the shared SQLite db. Safe to run while the bot
// and admin processes are up: WAL checkpoint flushes pending writes into
// the main file first, so the copy is never mid-transaction. Run on a
// schedule with cron, e.g. hourly:
//   0 * * * *  cd /path/to/bot-poly-market-server && npm run backup >> backup.log 2>&1
const KEEP = Number(process.env.BACKUP_KEEP ?? "48"); // ~2 days at hourly cadence

function main() {
  const dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH;
  if (!existsSync(dbPath)) {
    console.log(`No database at "${dbPath}" yet — nothing to back up.`);
    return;
  }

  const backupDir = process.env.BACKUP_DIR ?? "backups";
  mkdirSync(backupDir, { recursive: true });

  const db = openDb(dbPath);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(backupDir, `${basename(dbPath)}.${stamp}.bak`);
  copyFileSync(dbPath, dest);
  console.log(`Backed up ${dbPath} -> ${dest}`);

  const files = readdirSync(backupDir)
    .filter((f) => f.startsWith(`${basename(dbPath)}.`) && f.endsWith(".bak"))
    .map((f) => ({ f, mtime: statSync(join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const { f } of files.slice(KEEP)) {
    unlinkSync(join(backupDir, f));
    console.log(`Pruned old backup ${f}`);
  }
}

main();

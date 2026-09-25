import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sendAlert } from "./alerts.js";

// Shared by the bot process (writer) and the admin API process (reader +
// command writer). Must never import config.ts or anything touching
// PRIVATE_KEY — the admin process imports this file.
export type Db = DatabaseSync;

export const DEFAULT_DB_PATH = "data/bot.db";

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // WAL lets the admin process read while the bot writes; busy_timeout
  // absorbs the rare moment both write (bot: trades, admin: commands).
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS opportunities (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      question TEXT NOT NULL,
      yes_ask REAL NOT NULL,
      no_ask REAL NOT NULL,
      margin REAL NOT NULL,
      shares REAL NOT NULL,
      expected_profit REAL NOT NULL,
      liquidity REAL,
      volume REAL,
      reason TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_opp_ts ON opportunities(ts);

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      question TEXT NOT NULL,
      shares REAL NOT NULL,
      yes_ask REAL NOT NULL,
      no_ask REAL NOT NULL,
      margin REAL NOT NULL,
      yes_spend REAL NOT NULL,
      no_spend REAL NOT NULL,
      status TEXT NOT NULL,
      detail TEXT
    );

    CREATE TABLE IF NOT EXISTS positions (
      condition_id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      neg_risk INTEGER NOT NULL,
      shares REAL NOT NULL,
      cost REAL NOT NULL,
      opened_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      redeemed_at TEXT,
      redeem_tx TEXT
    );

    CREATE TABLE IF NOT EXISTS commands (
      id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Admin-panel accounts. Passwords are never stored in plaintext or in
    -- .env — only a salted scrypt hash lives here (see src/auth.ts), so a
    -- leaked DB file alone doesn't yield a usable credential.
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'guest')),
      created_at TEXT NOT NULL
    );

    -- Who did what, when. Separate from the commands table (bot-executed
    -- actions) since this also covers account/session events that never
    -- reach the bot (logins, user management).
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      username TEXT,
      action TEXT NOT NULL,
      detail TEXT,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
  `);
  return db;
}

export interface AuditEntry {
  username: string | null;
  action: string;
  detail?: unknown;
  ip?: string | null;
}

export function recordAudit(db: Db, e: AuditEntry): void {
  db.prepare(`INSERT INTO audit_log (ts, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)`).run(
    now(),
    e.username,
    e.action,
    e.detail === undefined ? null : JSON.stringify(e.detail),
    e.ip ?? null
  );
}

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: "admin" | "guest";
  created_at: string;
}

export function createUser(db: Db, username: string, passwordHash: string, role: "admin" | "guest"): number {
  const r = db
    .prepare(`INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)`)
    .run(username, passwordHash, role, now());
  return Number(r.lastInsertRowid);
}

export function findUserByUsername(db: Db, username: string): UserRow | undefined {
  return db.prepare(`SELECT * FROM users WHERE username = ?`).get(username) as UserRow | undefined;
}

export function findUserById(db: Db, id: number): UserRow | undefined {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
}

export function listUsers(db: Db): Omit<UserRow, "password_hash">[] {
  return db.prepare(`SELECT id, username, role, created_at FROM users ORDER BY id`).all() as Omit<
    UserRow,
    "password_hash"
  >[];
}

export function countAdmins(db: Db): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get() as { n: number }).n;
}

export function deleteUser(db: Db, id: number): void {
  db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
}

export function updateUserPassword(db: Db, id: number, passwordHash: string): void {
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(passwordHash, id);
}

const now = () => new Date().toISOString();

export type OpportunityReason = "dry-run" | "paused" | "below-execute-threshold" | "unsizeable" | "executed";

export interface OpportunityRow {
  conditionId: string;
  question: string;
  yesAsk: number;
  noAsk: number;
  margin: number;
  shares: number;
  liquidityNum?: number;
  volumeNum?: number;
  reason: OpportunityReason;
}

export function recordOpportunity(db: Db, o: OpportunityRow): void {
  db.prepare(
    `INSERT INTO opportunities (ts, condition_id, question, yes_ask, no_ask, margin, shares, expected_profit, liquidity, volume, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    now(),
    o.conditionId,
    o.question,
    o.yesAsk,
    o.noAsk,
    o.margin,
    o.shares,
    o.shares * o.margin,
    o.liquidityNum ?? null,
    o.volumeNum ?? null,
    o.reason
  );
}

export type TradeStatus = "filled" | "both_failed" | "partial_unwound" | "partial_unwind_failed";

export interface TradeRow {
  conditionId: string;
  question: string;
  negRisk: boolean;
  shares: number;
  yesAsk: number;
  noAsk: number;
  margin: number;
  yesSpend: number;
  noSpend: number;
  status: TradeStatus;
  detail?: unknown;
}

// A filled trade also opens/extends a position — both legs held until the
// market resolves and is redeemed. Partial fills are unwound, so they never
// reach the positions ledger (their outcome lives in `trades.detail`).
export function recordTrade(db: Db, t: TradeRow): void {
  const ts = now();
  db.prepare(
    `INSERT INTO trades (ts, condition_id, question, shares, yes_ask, no_ask, margin, yes_spend, no_spend, status, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ts,
    t.conditionId,
    t.question,
    t.shares,
    t.yesAsk,
    t.noAsk,
    t.margin,
    t.yesSpend,
    t.noSpend,
    t.status,
    t.detail === undefined ? null : JSON.stringify(t.detail)
  );

  if (t.status !== "filled") {
    const label = t.status === "both_failed" ? "❌ Both legs failed" : "⚠️ Partial fill unwind";
    void sendAlert(
      `${label}\nMarket: ${t.question}\nStatus: ${t.status}\nShares: ${t.shares}`
    );
    return;
  }
  db.prepare(
    `INSERT INTO positions (condition_id, question, neg_risk, shares, cost, opened_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(condition_id) DO UPDATE SET
       shares = shares + excluded.shares,
       cost = cost + excluded.cost,
       updated_at = excluded.updated_at`
  ).run(t.conditionId, t.question, t.negRisk ? 1 : 0, t.shares, t.yesSpend + t.noSpend, ts, ts);
}

export function markRedeemed(db: Db, conditionId: string, txHash: string): void {
  db.prepare(`UPDATE positions SET redeemed_at = ?, redeem_tx = ? WHERE condition_id = ?`).run(now(), txHash, conditionId);
}

// One aggregation shared by `npm run analyze` and the admin dashboard, so
// the two can never disagree on P&L.
export function summarize(db: Db) {
  const opp = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(shares > 0) AS sizeable,
              AVG(margin) AS avgMargin,
              SUM(CASE WHEN shares > 0 THEN expected_profit ELSE 0 END) AS hypotheticalProfit,
              AVG(liquidity) AS avgLiquidity,
              MIN(ts) AS firstTs,
              MAX(ts) AS lastTs
       FROM opportunities`
    )
    .get() as {
    total: number;
    sizeable: number | null;
    avgMargin: number | null;
    hypotheticalProfit: number | null;
    avgLiquidity: number | null;
    firstTs: string | null;
    lastTs: string | null;
  };

  const byReason = Object.fromEntries(
    (db.prepare(`SELECT reason, COUNT(*) AS n FROM opportunities GROUP BY reason`).all() as { reason: string; n: number }[]).map(
      (r) => [r.reason, r.n]
    )
  );

  const liqCount = (db.prepare(`SELECT COUNT(*) AS n FROM opportunities WHERE liquidity IS NOT NULL`).get() as { n: number }).n;
  const medianLiquidity = liqCount
    ? (
        db
          .prepare(`SELECT liquidity FROM opportunities WHERE liquidity IS NOT NULL ORDER BY liquidity LIMIT 1 OFFSET ?`)
          .get(Math.floor(liqCount / 2)) as { liquidity: number }
      ).liquidity
    : null;

  const tradesByStatus = Object.fromEntries(
    (db.prepare(`SELECT status, COUNT(*) AS n FROM trades GROUP BY status`).all() as { status: string; n: number }[]).map(
      (r) => [r.status, r.n]
    )
  );

  const filled = db
    .prepare(
      `SELECT COALESCE(SUM(yes_spend + no_spend), 0) AS cost, COALESCE(SUM(shares * margin), 0) AS expectedProfit
       FROM trades WHERE status = 'filled'`
    )
    .get() as { cost: number; expectedProfit: number };

  const openPositions = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(shares), 0) AS payout FROM positions WHERE redeemed_at IS NULL`)
    .get() as { n: number; cost: number; payout: number };

  return {
    opportunities: { ...opp, medianLiquidity, byReason },
    trades: { byStatus: tradesByStatus, filledCost: filled.cost, filledExpectedProfit: filled.expectedProfit },
    // payout = shares, since exactly one leg of each pair pays $1/share
    openPositions: { count: openPositions.n, lockedCapital: openPositions.cost, expectedPayout: openPositions.payout },
  };
}

export function getKv<T>(db: Db, key: string): T | undefined {
  const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export function setKv(db: Db, key: string, value: unknown): void {
  db.prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    key,
    JSON.stringify(value)
  );
}

export interface CommandRow {
  id: number;
  createdAt: string;
  type: string;
  payload: string;
}

export function insertCommand(db: Db, type: string, payload: unknown): number {
  const r = db.prepare(`INSERT INTO commands (created_at, type, payload) VALUES (?, ?, ?)`).run(now(), type, JSON.stringify(payload));
  return Number(r.lastInsertRowid);
}

export function pendingCommands(db: Db): CommandRow[] {
  return db
    .prepare(`SELECT id, created_at AS createdAt, type, payload FROM commands WHERE status = 'pending' ORDER BY id`)
    .all() as unknown as CommandRow[];
}

export function finishCommand(db: Db, id: number, status: "done" | "failed", result: unknown): void {
  db.prepare(`UPDATE commands SET status = ?, result = ?, processed_at = ? WHERE id = ?`).run(status, JSON.stringify(result), now(), id);
}

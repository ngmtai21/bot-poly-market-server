import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { publicEncrypt, constants as cryptoConstants, randomBytes } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import {
  DEFAULT_DB_PATH,
  openDb,
  getKv,
  setKv,
  insertCommand,
  summarize,
  createUser,
  findUserByUsername,
  findUserById,
  listUsers,
  countAdmins,
  deleteUser,
  updateUserPassword,
  recordAudit,
} from "../db.js";
import { validateCommand } from "../commands.js";
import { hashPassword, verifyPassword, createSessionToken, verifySessionToken, type Role, type SessionPayload } from "../auth.js";
import { sendAlert } from "../alerts.js";

// Pure JSON API (no static file serving — the admin-page UI is a separate
// project that calls this API over HTTP, from its own origin), as a
// SEPARATE process from the trading bot:
// - its event loop can't slow the bot's hot path, and
// - it never holds the wallet key. It only reads SQLite and queues
//   commands; the bot process validates and executes them.
// ESLint (eslint.config.js) blocks this folder from importing any module
// that touches PRIVATE_KEY or signing.

// Loads this repo's own .env — physically separate from the bot repo's
// .env.bot, which is the primary defense: PRIVATE_KEY/WALLET_KEY_DECRYPT_
// PRIVATE_KEY/CLOB_API_*/CTF_* simply don't exist in this file (see
// env.dist). Still parsed into a private object rather than process.env,
// and only the specific keys below are kept, as defense in depth against
// .env ever accidentally growing a stray sensitive var.
const fileEnv: Record<string, string> = {};
loadDotenv({ processEnv: fileEnv, path: ".env", quiet: true });
const env = (k: string) => process.env[k] ?? fileEnv[k];
const HOST = env("ADMIN_HOST") ?? "127.0.0.1";
const PORT = Number(env("ADMIN_PORT") ?? 8787);
const DB_PATH = env("DB_PATH") ?? DEFAULT_DB_PATH;
let SESSION_SECRET = env("SESSION_SECRET") ?? "";
// alerts.ts reads process.env directly (it's shared with the bot process,
// which has no fileEnv indirection) — these two carry no key material, so
// they're the only vars actually promoted into process.env here.
if (fileEnv.TELEGRAM_BOT_TOKEN) process.env.TELEGRAM_BOT_TOKEN = fileEnv.TELEGRAM_BOT_TOKEN;
if (fileEnv.TELEGRAM_CHAT_ID) process.env.TELEGRAM_CHAT_ID = fileEnv.TELEGRAM_CHAT_ID;
for (const k of Object.keys(fileEnv)) delete fileEnv[k];

if (!SESSION_SECRET) {
  // A signing secret, not a user credential — losing it lets someone forge
  // session tokens, but it alone never reveals a password or the wallet
  // key. Auto-generating one on first boot (and warning loudly) beats
  // forcing yet another value into .env before the API is usable; set
  // SESSION_SECRET explicitly in .env for a stable value across
  // restarts (otherwise every restart invalidates existing sessions).
  SESSION_SECRET = randomBytes32Hex();
  console.warn("SESSION_SECRET not set in .env — using a random one for this run (all sessions drop on restart).");
  console.warn(`Set SESSION_SECRET=${SESSION_SECRET} in .env to keep sessions stable across restarts.`);
}
function randomBytes32Hex(): string {
  return randomBytes(32).toString("hex");
}

const db = openDb(DB_PATH);
const HEARTBEAT_STALE_MS = 15_000;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

interface AuthedRequest extends IncomingMessage {
  session?: SessionPayload;
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

function authenticate(req: AuthedRequest): SessionPayload | null {
  const token = bearerToken(req);
  if (!token) return null;
  const session = verifySessionToken(token, SESSION_SECRET);
  if (!session) return null;
  // Reject sessions for users deleted after the token was issued.
  if (!findUserById(db, session.userId)) return null;
  req.session = session;
  return session;
}

// CSP/frame-ancestors etc. only matter for HTML documents a browser
// renders — this server never serves one, so just the generic API
// hardening headers apply here.
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 10_000) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function limitParam(url: URL): number {
  const n = Number(url.searchParams.get("limit") ?? 200);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 1000) : 200;
}

function userView(u: { id: number; username: string; role: Role; created_at: string }) {
  return { id: u.id, username: u.username, role: u.role, createdAt: u.created_at };
}

function clientIp(req: IncomingMessage): string | null {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress ?? null;
}

// Login brute-force lockout, per IP. In-memory (resets on restart) — this
// process is a single instance behind an SSH tunnel, not a distributed
// deployment, so that's not a real weakness here.
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map<string, { count: number; windowStart: number }>();

function loginLockedOut(key: string): boolean {
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(key: string): void {
  const entry = loginAttempts.get(key);
  if (!entry || Date.now() - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, windowStart: Date.now() });
  } else {
    entry.count++;
  }
}

function clearLoginFailures(key: string): void {
  loginAttempts.delete(key);
}

async function handleApi(req: AuthedRequest, res: ServerResponse, url: URL): Promise<void> {
  const route = `${req.method} ${url.pathname}`;

  // Login is the only unauthenticated route.
  if (route === "POST /api/auth/login") {
    const ip = clientIp(req);
    const lockoutKey = ip ?? "unknown";
    if (loginLockedOut(lockoutKey)) {
      return send(res, 429, { error: "too many failed login attempts — try again later" });
    }

    let body: { username?: unknown; password?: unknown };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      return send(res, 400, { error: "invalid JSON body" });
    }
    if (typeof body.username !== "string" || typeof body.password !== "string") {
      return send(res, 400, { error: "username and password are required" });
    }
    const user = findUserByUsername(db, body.username);
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      recordLoginFailure(lockoutKey);
      recordAudit(db, { username: body.username, action: "login_failed", ip });
      return send(res, 401, { error: "invalid username or password" });
    }
    clearLoginFailures(lockoutKey);
    recordAudit(db, { username: user.username, action: "login", ip });
    void sendAlert(`🔑 Login: <b>${user.username}</b> (${user.role})${ip ? ` from ${ip}` : ""}`);
    const token = createSessionToken({ userId: user.id, username: user.username, role: user.role }, SESSION_SECRET);
    return send(res, 200, { token, username: user.username, role: user.role });
  }

  const session = authenticate(req);
  if (!session) return send(res, 401, { error: "unauthorized" });
  const isAdmin = session.role === "admin";
  const requireAdmin = () => isAdmin;

  switch (route) {
    case "POST /api/auth/change-password": {
      let body: { currentPassword?: unknown; newPassword?: unknown };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        return send(res, 400, { error: "invalid JSON body" });
      }
      const user = findUserById(db, session.userId)!;
      if (typeof body.currentPassword !== "string" || !verifyPassword(body.currentPassword, user.password_hash)) {
        return send(res, 400, { error: "current password is incorrect" });
      }
      if (typeof body.newPassword !== "string" || body.newPassword.length < 8) {
        return send(res, 400, { error: "newPassword must be at least 8 characters" });
      }
      updateUserPassword(db, user.id, hashPassword(body.newPassword));
      recordAudit(db, { username: user.username, action: "change_password_self", ip: clientIp(req) });
      return send(res, 200, { ok: true });
    }

    case "GET /api/status": {
      const status = getKv<Record<string, unknown>>(db, "status");
      const age = status ? Date.now() - Date.parse(String(status.heartbeat)) : null;
      return send(res, 200, { status, heartbeatAgeMs: age, online: age !== null && age < HEARTBEAT_STALE_MS });
    }
    case "GET /api/summary":
      return send(res, 200, summarize(db));
    case "GET /api/opportunities": {
      const reason = url.searchParams.get("reason");
      const rows = reason
        ? db.prepare(`SELECT * FROM opportunities WHERE reason = ? ORDER BY id DESC LIMIT ?`).all(reason, limitParam(url))
        : db.prepare(`SELECT * FROM opportunities ORDER BY id DESC LIMIT ?`).all(limitParam(url));
      return send(res, 200, rows);
    }
    case "GET /api/trades":
      return send(res, 200, db.prepare(`SELECT * FROM trades ORDER BY id DESC LIMIT ?`).all(limitParam(url)));
    case "GET /api/positions":
      return send(res, 200, db.prepare(`SELECT * FROM positions ORDER BY redeemed_at IS NOT NULL, opened_at DESC`).all());
    case "GET /api/commands":
      return send(res, 200, db.prepare(`SELECT * FROM commands ORDER BY id DESC LIMIT ?`).all(limitParam(url)));

    case "POST /api/commands": {
      if (!requireAdmin()) return send(res, 403, { error: "admin role required" });
      let body: { type?: unknown; payload?: unknown };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        return send(res, 400, { error: "invalid JSON body" });
      }
      try {
        const cmd = validateCommand(body.type, body.payload);
        return send(res, 201, { id: insertCommand(db, cmd.type, cmd.payload) });
      } catch (err) {
        return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }


    // ---- User management (admin only) ----
    case "GET /api/users": {
      if (!requireAdmin()) return send(res, 403, { error: "admin role required" });
      return send(res, 200, listUsers(db).map(userView));
    }
    case "POST /api/users": {
      if (!requireAdmin()) return send(res, 403, { error: "admin role required" });
      let body: { username?: unknown; password?: unknown; role?: unknown };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        return send(res, 400, { error: "invalid JSON body" });
      }
      if (typeof body.username !== "string" || !/^[a-zA-Z0-9_.-]{3,32}$/.test(body.username)) {
        return send(res, 400, { error: "username must be 3-32 chars (letters, digits, _ . -)" });
      }
      if (typeof body.password !== "string" || body.password.length < 8) {
        return send(res, 400, { error: "password must be at least 8 characters" });
      }
      if (body.role !== "admin" && body.role !== "guest") {
        return send(res, 400, { error: "role must be 'admin' or 'guest'" });
      }
      if (findUserByUsername(db, body.username)) {
        return send(res, 400, { error: "username already exists" });
      }
      const id = createUser(db, body.username, hashPassword(body.password), body.role);
      recordAudit(db, {
        username: session.username,
        action: "create_user",
        detail: { targetUsername: body.username, role: body.role },
        ip: clientIp(req),
      });
      return send(res, 201, { id });
    }

    // ---- Audit log (admin only) ----
    case "GET /api/audit":
      if (!requireAdmin()) return send(res, 403, { error: "admin role required" });
      return send(res, 200, db.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`).all(limitParam(url)));

    default:
      break;
  }

  // Routes with a path parameter.
  const userIdMatch = url.pathname.match(/^\/api\/users\/(\d+)$/);
  if (userIdMatch && req.method === "DELETE") {
    if (!requireAdmin()) return send(res, 403, { error: "admin role required" });
    const id = Number(userIdMatch[1]);
    const target = findUserById(db, id);
    if (!target) return send(res, 404, { error: "not found" });
    if (id === session.userId) return send(res, 400, { error: "cannot delete your own account" });
    if (target.role === "admin" && countAdmins(db) <= 1) {
      return send(res, 400, { error: "cannot delete the last admin account" });
    }
    deleteUser(db, id);
    recordAudit(db, {
      username: session.username,
      action: "delete_user",
      detail: { targetUsername: target.username },
      ip: clientIp(req),
    });
    return send(res, 200, { ok: true });
  }
  const resetMatch = url.pathname.match(/^\/api\/users\/(\d+)\/reset-password$/);
  if (resetMatch && req.method === "POST") {
    if (!requireAdmin()) return send(res, 403, { error: "admin role required" });
    const id = Number(resetMatch[1]);
    const target = findUserById(db, id);
    if (!target) return send(res, 404, { error: "not found" });
    let body: { password?: unknown };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      return send(res, 400, { error: "invalid JSON body" });
    }
    if (typeof body.password !== "string" || body.password.length < 8) {
      return send(res, 400, { error: "password must be at least 8 characters" });
    }
    updateUserPassword(db, id, hashPassword(body.password));
    recordAudit(db, {
      username: session.username,
      action: "reset_password",
      detail: { targetUsername: target.username },
      ip: clientIp(req),
    });
    return send(res, 200, { ok: true });
  }

  // ---- Contract-address config (view: any role, edit: admin only) ----
  if (route === "GET /api/config/addresses") {
    return send(
      res,
      200,
      getKv(db, "contractAddresses") ?? {
        ctfAdapterAddress: "",
        negRiskCtfAdapterAddress: "",
        collateralTokenAddress: "",
      }
    );
  }
  if (route === "PUT /api/config/addresses") {
    if (!requireAdmin()) return send(res, 403, { error: "admin role required" });
    let body: Record<string, unknown>;
    try {
      body = (await readJson(req)) as Record<string, unknown>;
    } catch {
      return send(res, 400, { error: "invalid JSON body" });
    }
    const fields = ["ctfAdapterAddress", "negRiskCtfAdapterAddress", "collateralTokenAddress"] as const;
    const out: Record<string, string> = {};
    for (const f of fields) {
      const v = body[f];
      if (v === undefined || v === "") {
        out[f] = "";
        continue;
      }
      if (typeof v !== "string" || !HEX_ADDRESS.test(v)) {
        return send(res, 400, { error: `${f} must be a 0x-prefixed 20-byte hex address` });
      }
      out[f] = v;
    }
    setKv(db, "contractAddresses", out);
    recordAudit(db, { username: session.username, action: "update_contract_addresses", detail: out, ip: clientIp(req) });
    return send(res, 200, out);
  }

  // ---- Wallet key rotation (admin only) ----
  // The admin process only ever holds the PUBLIC half of this keypair — it
  // can encrypt a new key but never decrypt one. Only the bot process,
  // which holds WALLET_KEY_DECRYPT_PRIVATE_KEY in its own .env.bot, can recover
  // the plaintext (see src/walletKeyRotation.ts).
  if (route === "GET /api/wallet/rotation-status") {
    if (!requireAdmin()) return send(res, 403, { error: "admin role required" });
    const publicKey = getKv<string>(db, "walletKeyPublicKey");
    const staged = getKv<{ stagedAt: string }>(db, "stagedWalletKey");
    return send(res, 200, { enabled: !!publicKey, stagedAt: staged?.stagedAt ?? null });
  }
  if (route === "POST /api/wallet/stage-key") {
    if (!requireAdmin()) return send(res, 403, { error: "admin role required" });
    const publicKey = getKv<string>(db, "walletKeyPublicKey");
    if (!publicKey) {
      return send(res, 400, { error: "rotation keypair not set up — run `npm run setup-admin` on the server first" });
    }
    let body: { privateKey?: unknown };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      return send(res, 400, { error: "invalid JSON body" });
    }
    if (typeof body.privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.privateKey)) {
      return send(res, 400, { error: "privateKey must be a 0x-prefixed 32-byte hex string" });
    }
    // Encrypt immediately; the plaintext is never logged, persisted, or
    // held longer than this request.
    const ciphertext = publicEncrypt(
      { key: publicKey, oaepHash: "sha256", padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING },
      Buffer.from(body.privateKey, "utf8")
    ).toString("base64");
    body.privateKey = "";
    setKv(db, "stagedWalletKey", { ciphertext, stagedAt: new Date().toISOString() });
    recordAudit(db, { username: session.username, action: "stage_wallet_key", ip: clientIp(req) });
    void sendAlert(`🔐 Wallet key rotation staged by <b>${session.username}</b> — restart the bot to apply.`);
    return send(res, 200, { ok: true, note: "Staged — restart the bot process (npm run scan) to apply it." });
  }

  return send(res, 404, { error: "not found" });
}

if (countAdmins(db) === 0) {
  console.warn("No admin account exists yet — run `npm run setup-admin` before logging in.");
}

// Offline watchdog: this process outlives the bot process, so it's the one
// that can actually notice and alert when the bot stops sending heartbeats
// — the bot obviously can't alert on its own crash. Alerts once per
// transition, not on every tick, so a dead bot doesn't spam the chat.
let lastKnownOnline = true;
setInterval(() => {
  const status = getKv<Record<string, unknown>>(db, "status");
  const age = status ? Date.now() - Date.parse(String(status.heartbeat)) : null;
  const online = age !== null && age < HEARTBEAT_STALE_MS;
  if (lastKnownOnline && !online) {
    void sendAlert(`🔴 Bot heartbeat lost (last seen ${age ? Math.round(age / 1000) : "?"}s ago).`);
  } else if (!lastKnownOnline && online) {
    void sendAlert(`🟢 Bot is back online.`);
  }
  lastKnownOnline = online;
}, 10_000);

createServer((req, res) => {
  // Bearer-token auth (no cookies), so reflecting the caller's Origin is
  // safe from CSRF — it only widens *which pages* can read a response the
  // caller must already have a valid session token to obtain. Needed
  // because the admin-page UI is a separate project/origin (its own dev
  // server or static host) calling this API, not served by this process.
  if (req.headers.origin) {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  handleApi(req, res, url).catch((err) => {
    console.error("admin request failed", err);
    if (!res.headersSent) send(res, 500, { error: "internal error" });
  });
}).listen(PORT, HOST, () => {
  console.log(`Admin API on http://${HOST}:${PORT} (db: ${DB_PATH})`);
  if (HOST !== "127.0.0.1" && HOST !== "localhost") {
    console.warn("WARNING: admin is bound to a non-loopback address — prefer 127.0.0.1 + SSH tunnel.");
  }
});

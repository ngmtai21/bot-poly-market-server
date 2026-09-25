# Polymarket arbitrage bot

Detects within-market arbitrage on Polymarket: for a binary market, if
`YES ask + NO ask < 1` (after fees), buying both sides locks in a profit
regardless of outcome. Includes a web admin panel to monitor and control it.

See [STRATEGY.md](STRATEGY.md) for a diagrammed walkthrough of the pipeline
and the reasoning behind it.

## Setup

Two separate env files, one per process — **not just organizational**: the
bot's file is the only place `PRIVATE_KEY` ever lives, and the admin
process never loads it (see "Two env files" below).

1. `cp env.bot.dist .env.bot` and fill in `PRIVATE_KEY` (Polygon EOA wallet
   key — never commit this).
   `cp env.admin.dist .env.admin` and fill in `SESSION_SECRET`.
2. `npm install`
3. `npm run setup-api-key` — derives CLOB API key/secret/passphrase; paste
   into `.env.bot`.
4. `npm run setup-admin` — creates the first admin login (see "Admin API").
5. For live trading only: fund the Polymarket proxy wallet with USDC.e and
   keep some POL for gas (needed to redeem).

## Two env files

`config.ts` (bot) loads `.env.bot` explicitly; `admin/server.ts` loads
`.env.admin` explicitly — neither falls back to a shared/ambiguous `.env`.
This is enforced by which file physically contains which variables, not
just by runtime filtering (though the admin process also keeps a private
copy of what it reads, as defense in depth):

| | `.env.bot` | `.env.admin` |
|---|---|---|
| `PRIVATE_KEY`, `WALLET_KEY_DECRYPT_PRIVATE_KEY` | ✓ | never |
| `CLOB_API_*`, `CTF_*`/`COLLATERAL_TOKEN_ADDRESS` | ✓ | never |
| Trading thresholds, `ENABLE_TRADING` | ✓ | never |
| `DB_PATH` | ✓ (must match) | ✓ (must match) |
| `SESSION_SECRET`, `ADMIN_HOST`, `ADMIN_PORT` | never | ✓ |
| `TELEGRAM_BOT_TOKEN`/`CHAT_ID` | ✓ (bot-side alerts) | ✓ (admin-side alerts) |
| `BACKUP_DIR`/`BACKUP_KEEP` | ✓ | never |

Both `.env.bot` and `.env.admin` are gitignored. `npm run setup-admin` and
the one-off scripts (`setup-api-key`, `backup`, `status`, `analyze`,
`redeem`, `integration-test`) all read `.env.bot` (they need `DB_PATH` and,
for most of them, transitively import `config.ts`).

## Running

Two separate processes, sharing one SQLite file (`data/bot.db`), started via
[ecosystem.config.cjs](ecosystem.config.cjs):

```bash
pm2 start ecosystem.config.cjs   # first deploy
pm2 save                         # persist across VPS reboots (also run: pm2 startup)
```

After a `git pull` on the VPS to ship changes:

```bash
git pull
npm install                       # if package.json changed
pm2 reload ecosystem.config.cjs   # restarts both with the new code/env files
```

Single-service commands when you only need one:
`pm2 restart polymarket-bot` / `pm2 restart polymarket-admin`,
`pm2 logs polymarket-bot`, `pm2 status`.

They're separate on purpose: the admin's HTTP traffic can't slow the bot's
event loop, and a compromised web layer can't reach the wallet key. The
admin only queues commands in SQLite; the bot re-validates and executes
them.

**The bot's speed is never traded off for the admin panel.** Two separate
Node processes means separate event loops — admin HTTP handling cannot
delay the bot's WS message processing regardless of load. At the SQLite
layer (WAL mode), this was measured directly: a reader hammering
`summarize()` in a tight loop (~5000 calls/sec — far past anything the
5s-polling UI generates) left the bot's write latency unchanged (p99
0.33ms → 0.31ms). `npm run scan` also runs at a higher OS scheduling
priority than `npm run admin` (`nice -n -5` vs `-n 10` — needs root, which
the VPS runs as; degrades harmlessly to normal priority otherwise) as a
belt-and-suspenders guarantee under CPU pressure.

## Admin API

Pure JSON API, no UI served from this repo — the admin-page frontend is a
separate project that calls this API over HTTP from its own origin (dev
server or static host). CORS reflects the caller's `Origin` dynamically and
auth is bearer-token (not cookies), so this is safe by design: see
`src/admin/server.ts`'s CORS comment.

Username/password login, not a static bearer token — accounts live in the
shared SQLite db (`users` table, scrypt-hashed passwords, never in any env
file or plaintext anywhere).

- Set `SESSION_SECRET` in `.env.admin` (any random string — signs login
  sessions; if left unset the process generates one at startup and warns,
  but every session drops on restart).
- Create the first account: `npm run setup-admin` — interactive by default
  (prompts for username/password, optionally generates the wallet-key-
  rotation keypair). Safe to re-run; skips creating a user that already
  exists.
- **Non-interactive** (deploy scripts/CI, where nothing can answer a
  prompt): set `ADMIN_USERNAME` and run with `< /dev/null` or any closed/
  piped stdin — it detects the non-TTY and never blocks on a prompt.
  `ADMIN_PASSWORD` unset still auto-generates and prints one; a genuinely
  missing `ADMIN_USERNAME` fails loudly (exit 1) instead of hanging.
  ```bash
  ADMIN_USERNAME=admin ADMIN_GENERATE_ROTATION_KEYS=yes npm run setup-admin
  ```
- It binds to `127.0.0.1:8787` by default — **don't expose it publicly**.
  From your laptop: `ssh -L 8787:127.0.0.1:8787 root@<vps>`, then point the
  admin-page project's API base URL at `http://localhost:8787`.

Endpoints (all under `/api/`, all but login require `Authorization: Bearer
<token>` from `POST /api/auth/login`):
- `GET status` / `summary` / `opportunities` / `trades` / `positions` /
  `commands` / `audit` — everything the bot has recorded, and its heartbeat.
- `POST commands` — queue a `set_config | pause | resume | stop | start |
  redeem` command for the bot to validate and execute (admin role only).
- `GET/POST users`, `DELETE users/:id`, `POST users/:id/reset-password` —
  account management (admin role only; can't delete the last admin or
  yourself).
- `POST auth/change-password` — any logged-in user, own account.
- `GET/PUT config/addresses` — the redeem contract addresses (view: any
  role, edit: admin only).
- `GET wallet/rotation-status`, `POST wallet/stage-key` — see "Rotating the
  wallet key" below.

Control safety: `set_config { enableTrading: true }` requires the bot to
re-pass the same balance/allowance preflight as startup (rolled back if it
fails); `maxOrderSizeUsdc` is capped at `MAX_ORDER_SIZE_CEILING_USDC` ($1000)
regardless of what a request sends; commands expire after 60s so one queued
while the bot was down never fires hours later. Settings changed via
`set_config`/`pause`/`stop` persist across restarts and **override the env
files** (logged at startup).

**Every control action goes through one path, on purpose** (see
[STRATEGY.md](STRATEGY.md) for the full model): the admin process only ever
*requests* — it writes a command to a queue in SQLite. The bot process (the
only one holding the wallet key) polls that queue, re-validates, and
executes. The admin process has zero direct power over the OS process or
the wallet, even if fully compromised.

The `stop`/`start` commands are **not** OS-level process control —
`pm2` keeps the bot process itself always running (crash-recovery via
`autorestart`). "Stop" is an event the bot acts on by disconnecting its
WebSocket and idling down to just its 1s command poll (so it can still hear
a future "start"); "pause" (different button) is shallower — it stays fully
connected and scanning, only skipping trade execution. The stopped/running
choice is persisted, so a crash-restart resumes in whatever state the
operator last left it in rather than silently reconnecting.

## Checking the pipeline

```bash
npm run self-test         # logic: margin/fee/sizing, ledger math, command validation
npm run integration-test  # live network + local order signing (nothing submitted)
npm run status            # is the bot alive, what has it seen
npm run analyze           # full summary (same numbers as the dashboard)
```

There's no historical backtest — Polymarket doesn't expose historical
orderbook depth. Dry-run (`ENABLE_TRADING=false`, the default) is the
substitute: every opportunity is recorded with why it wasn't traded.

## Fees

Taker fee is `shares * feeRate * p * (1-p)` per leg, feeRate per market (up
to ~10% observed), peaking near p=0.5. The bot fetches each market's real
rate and subtracts it before comparing against the thresholds.

## Two-tier margin strategy

- `MIN_PROFIT_MARGIN` (default `0.01`) — "worth recording". Shows true
  opportunity frequency even for margins too thin to trade.
- `EXECUTE_MARGIN_THRESHOLD` (default `0.05`) — "worth risking capital".
  From a non-US VPS (~250ms RTT) a thin margin is usually gone before the
  order lands. Between the two thresholds: recorded as
  `below-execute-threshold`, never traded.

## Claiming winnings

Payout after resolution isn't automatic — winning tokens are redeemed with an
on-chain `redeemPositions` call (costs POL). Send a `redeem` command via the
admin API (or the admin-page UI, once built), or run
`npm run redeem -- <conditionId> [--neg-risk]` directly.

**You must supply the contract addresses yourself** (`CTF_ADAPTER_ADDRESS`,
`NEG_RISK_CTF_ADAPTER_ADDRESS`, `COLLATERAL_TOKEN_ADDRESS`, in `.env.bot`);
they're blank in `env.bot.dist` on purpose. Docs cross-referencing didn't
yield an address confirmable with confidence (docs mention a newer "pUSD"
flow). **Don't
paste an address from an AI response or an unverified webpage** — a wrong
one can burn your tokens irreversibly. Safest way: redeem one resolved
position manually on polymarket.com, open that tx on polygonscan.com — the
"To" address is the adapter for that market type; the token received is the
collateral.

## Status

- [x] Full market coverage (~2100 markets via paginated Gamma API)
- [x] Live orderbooks: WS `price_change` deltas + REST snapshots (on connect, every 10 min)
- [x] Fee-aware net margin, two-tier thresholds, depth/min-order-size sizing
- [x] Execution: both legs FOK, partial fill unwound, gated by `ENABLE_TRADING`
- [x] Balance/allowance preflight (startup and on every live config change)
- [x] SQLite ledger: opportunities, trades, positions, commands, settings
- [x] Admin API: auth, user management, commands queue, wallet-key rotation, redeem
- [x] Zero known dependency vulnerabilities
- [ ] Admin-page UI (separate project — this repo is API-only)
- [ ] Automatic redeem when a held market resolves (manual command for now)
- [ ] Circuit breaker on repeated failures

## Backlog

**Infra (biggest lever):**
- [ ] Move VPS to US East — ~250ms RTT today; est. ~10-30ms after. Test
      candidates with
      `curl -s -o /dev/null -w "%{time_starttransfer}\n" https://clob.polymarket.com/`
      before committing.

**Reliability:**
- [ ] Circuit breaker — stop after N consecutive execution failures.
- [ ] Observe a real `createAndPostMarketOrder` fill/reject — the `.success`
      handling matches docs but has never seen a live response.
- [ ] Auto-redeem: watch Gamma for resolution of markets in `positions`,
      queue a redeem command.

**Strategy validation:**
- [ ] Let dry-run collect data 24h+ (on the US VPS), then check the
      dashboard: frequency above 5%, and whether opportunities skew toward
      low-liquidity markets.

**Decided against (don't redo without new evidence):**
- Go/Rust rewrite — bottleneck is network RTT, not code (<5ms overhead measured).
- Worker threads — bot is I/O-bound; per-event work is sub-millisecond.
- Guessing fee by category — superseded by `client.getFeeRateBps()`.
- React/Vite for the admin UI — three static files, no build step; revisit
  if the UI grows substantially.

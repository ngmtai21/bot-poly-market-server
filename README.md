# Polymarket arbitrage bot — admin API

Admin control panel API for the [bot](../bot) that detects within-market
arbitrage on Polymarket: for a binary market, if `YES ask + NO ask < 1`
(after fees), buying both sides locks in a profit regardless of outcome.

This repo is **admin-only** — a pure JSON HTTP API, no UI served here. The
bot itself (the process holding `PRIVATE_KEY`, actually trading) lives in
the sibling [`../bot`](../bot) repo. See [`../bot/STRATEGY.md`](../bot/STRATEGY.md)
for the strategy walkthrough.

## Setup

1. `cp env.admin.dist .env.admin` and fill in `SESSION_SECRET`, `DB_PATH`
   (must point at the same `data/bot.db` the bot repo uses).
2. `npm install`
3. `npm run setup-admin` — creates the first admin login (see "Admin API").

## Deploying to a VPS

This repo doesn't need the `../bot` repo present to run — it only needs to
read the same `data/bot.db` file, wherever that lives. Simplest is cloning
both repos as siblings on the VPS (matches `DB_PATH=data/bot.db` relative
paths in both `.env` files), but any layout works as long as `DB_PATH` in
`.env.admin` and in the bot's `.env.bot` resolve to the same file.

```bash
# on the VPS, once:
git clone <this-repo-url> server && cd server
npm install -g pm2   # if not already installed
cp env.admin.dist .env.admin
# fill in SESSION_SECRET (see "Admin API" below), ADMIN_HOST/PORT, DB_PATH
npm install
npm run setup-admin   # creates the first admin login

pm2 start ecosystem.config.cjs
pm2 save               # persist across reboots
pm2 startup            # follow its printed instructions once, for cold boots
```

Shipping a change after that:

```bash
git pull
npm install                       # only if package.json changed
pm2 reload ecosystem.config.cjs   # zero-downtime restart with new code/env
```

The API binds to `127.0.0.1:8787` only — reach it from your laptop via
`ssh -L 8787:127.0.0.1:8787 root@<vps>`, never by opening the port publicly
(see "Admin API" below).

## Two repos, one SQLite file

`admin/server.ts` loads `.env.admin` explicitly — it never touches
`PRIVATE_KEY`, which lives only in `../bot/.env.bot`. Physical separation
(different files, different repos) is the primary defense; the admin
process also keeps a private copy of what it reads (`processEnv: {}`) as
defense in depth.

`db.ts`, `commands.ts`, `logger.ts`, and `alerts.ts` are duplicated between
this repo and `../bot`, kept in sync by hand — see CLAUDE.md for why.

## Running

```bash
pm2 start ecosystem.config.cjs   # first deploy
pm2 save                         # persist across VPS reboots (also run: pm2 startup)
```

After a `git pull` to ship changes: `npm install` (if `package.json`
changed) then `pm2 reload ecosystem.config.cjs`. Single-service commands:
`pm2 restart polymarket-admin`, `pm2 logs polymarket-admin`, `pm2 status`.

Runs at normal OS priority (`nice -n 10`) so it never contends with the
bot's `nice -n -5` scan loop for CPU — the two are separate processes with
separate event loops regardless.

## Admin API

Pure JSON API — the admin-page frontend is a separate project that calls
this API over HTTP from its own origin (dev server or static host). CORS
reflects the caller's `Origin` dynamically and auth is bearer-token (not
cookies), so that's safe by design: see `src/admin/server.ts`'s CORS
comment.

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
- `GET wallet/rotation-status`, `POST wallet/stage-key` — see the bot
  repo's README, "Rotating the wallet key".

Control safety: `set_config { enableTrading: true }` requires the bot to
re-pass the same balance/allowance preflight as startup (rolled back if it
fails); `maxOrderSizeUsdc` is capped at `MAX_ORDER_SIZE_CEILING_USDC` ($1000)
regardless of what a request sends; commands expire after 60s so one queued
while the bot was down never fires hours later. Settings changed via
`set_config`/`pause`/`stop` persist across restarts and **override the
bot's env file** (logged at startup, in the bot process).

**Every control action goes through one path, on purpose**: the admin
process only ever *requests* — it writes a command to a queue in SQLite.
The bot process (the only one holding the wallet key) polls that queue,
re-validates, and executes. The admin process has zero direct power over
the OS process or the wallet, even if fully compromised.

The `stop`/`start` commands are **not** OS-level process control — `pm2`
(in the bot repo) keeps the bot process itself always running
(crash-recovery via `autorestart`). "Stop" is an event the bot acts on by
disconnecting its WebSocket and idling down to just its 1s command poll (so
it can still hear a future "start"); "pause" (different button) is
shallower — it stays fully connected and scanning, only skipping trade
execution. The stopped/running choice is persisted, so a crash-restart
resumes in whatever state the operator last left it in rather than silently
reconnecting.

## Reporting

```bash
npm run status   # is the bot alive, what has it seen
npm run analyze  # full summary (same numbers as /api/summary)
npm run backup   # copy the SQLite file out, prune old backups
```

## Status

- [x] SQLite ledger reads: opportunities, trades, positions, commands, settings
- [x] Auth, user management, commands queue, wallet-key rotation, redeem
- [x] Zero known dependency vulnerabilities
- [ ] Admin-page UI (separate project — this repo is API-only)

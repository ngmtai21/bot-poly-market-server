# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The admin API for a Polymarket within-market arbitrage bot. This repo is **admin-only** — a pure JSON HTTP API (`node:http`, no framework, no UI served here) that reads the bot's SQLite database and queues commands for it. The bot itself (the process that holds `PRIVATE_KEY` and actually trades) lives in a sibling repo, `../bot`. See README.md for operations.

## Commands

```bash
npm run admin             # admin API: HTTP + JSON only; never loads PRIVATE_KEY
npm run setup-admin       # bootstrap the first admin login (interactive; non-interactive via ADMIN_USERNAME/ADMIN_PASSWORD env vars — see src/scripts/setup-admin.ts)
npm run status            # is the bot alive (heartbeat in SQLite), latest opportunity
npm run analyze           # summary from SQLite (same summarize() as /api/summary)
npm run backup            # copy the SQLite file out, prune old backups
npm run build             # tsc
npm run lint              # eslint src
```

`node:sqlite` is built into Node 22 but emits an ExperimentalWarning; npm scripts pass `--disable-warning=ExperimentalWarning` to tsx so it doesn't land in pm2's error log.

## Two repos, one SQLite file

- **This repo (admin)** ([src/admin/server.ts](src/admin/server.ts)) — reads SQLite, inserts commands, serves a pure JSON API. The admin-page UI is a separate frontend project that calls this API cross-origin (CORS reflects the caller's `Origin` dynamically; bearer-token auth, no cookies, so that's CSRF-safe). Loads `.env` explicitly (`dotenv`'s `path` option, not the bare `dotenv/config` auto-import) into a private object (`processEnv: {}`) — a physically separate file from the bot's `.env.bot`, in a physically separate repo, is the primary defense for keeping `PRIVATE_KEY` out of this process; the fileEnv indirection is defense in depth on top of that.
- **Sibling repo (`../bot`)** — the only process with `PRIVATE_KEY`. Writes opportunities/trades/positions and a status heartbeat; polls the `commands` table every second.
- The two never call each other directly (no RPC/HTTP between them) — only the shared SQLite file. Its schema, in [src/db.ts](src/db.ts), is the contract. SQLite runs in WAL mode with `busy_timeout` for concurrent access from both processes.

**`db.ts`, `commands.ts`, `logger.ts`, and `alerts.ts` are intentionally duplicated between this repo and `../bot`** — not a shared npm package. This was a deliberate trade-off: two repos that don't import each other (cleaner ownership, independent deploys) at the cost of keeping these four files in sync by hand whenever the schema or command validation changes. `db.ts` — schema + all read/write helpers. Tables: `opportunities` (every detected opportunity + `reason`: dry-run | paused | below-execute-threshold | unsizeable | executed), `trades` (real executions: filled | both_failed | partial_unwound | partial_unwind_failed), `positions` (ledger: a `filled` trade upserts by conditionId; cleared by `markRedeemed`), `commands` (admin→bot queue), `kv` (`status` heartbeat, `settings` overrides). `summarize()` is the single P&L aggregation used by both `npm run analyze` and `/api/summary`.

`commands.ts` — `validateCommand()` for `set_config | pause | resume | stop | start | redeem`. This copy is only an early UX-level reject; the bot repo's own copy is the real trust boundary and re-validates everything, since the admin process could be compromised. UI-settable `maxOrderSizeUsdc` capped at `MAX_ORDER_SIZE_CEILING_USDC`.

## Web UI

There is no UI in this repo — the admin-page frontend is a separate project that calls this API over HTTP from its own origin (a dev server during development, a static host in production). Polymarket's own Gamma/CLOB REST and its market WebSocket are public and CORS-open, so that frontend can fetch live orderbook/market data directly from the browser without proxying through this API.

## Conventions

- ESM throughout (`"type": "module"` + `NodeNext`) — relative imports use explicit `.js` extensions.
- Never commit `.env`; never put `PRIVATE_KEY` in it. `data/` (SQLite) is gitignored.

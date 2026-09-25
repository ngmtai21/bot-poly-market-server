# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Polymarket within-market arbitrage bot plus a web admin panel. For a binary market, if `YES ask + NO ask < 1` (after fees), buying both sides locks in a profit regardless of outcome. Live order placement is gated behind `config.enableTrading` (`ENABLE_TRADING=true` in `.env.bot`, or toggled from the admin panel), off by default — dry-run records every opportunity to SQLite without trading. See README.md for operations, STRATEGY.md for the strategy walkthrough.

## Commands

```bash
npm run scan              # trading bot (process 1): live orderbooks -> detect -> execute; holds the key
npm run admin             # admin API (process 2): pure JSON API, no UI served here; never loads the key
npm run setup-api-key     # one-time: derive CLOB API creds from PRIVATE_KEY, paste into .env.bot
npm run setup-admin       # bootstrap the first admin login + optional wallet-key-rotation keypair (interactive; non-interactive via ADMIN_USERNAME/ADMIN_PASSWORD/ADMIN_GENERATE_ROTATION_KEYS env vars — see src/scripts/setup-admin.ts)
npm run status            # is the bot alive (heartbeat in SQLite), latest opportunity
npm run analyze           # summary from SQLite (same summarize() as the dashboard)
npm run self-test         # assert-based logic tests (margin/fee/sizing, ledger, command validation)
npm run integration-test  # live network: Gamma, CLOB REST, fee rate, local order signing (nothing submitted)
npm run redeem -- <conditionId> [--neg-risk]   # manual on-chain redeem
npm run build             # tsc
npm run lint              # eslint src (includes the admin import restriction)
```

`node:sqlite` is built into Node 22 but emits an ExperimentalWarning; npm scripts pass `--disable-warning=ExperimentalWarning` to tsx so it doesn't land in pm2's error log.

## Two processes, one SQLite file

- **Bot** ([src/scan.ts](src/scan.ts)) — the only process with `PRIVATE_KEY`. Writes opportunities/trades/positions and a status heartbeat; polls the `commands` table every second via [src/control.ts](src/control.ts).
- **Admin** ([src/admin/server.ts](src/admin/server.ts), `node:http`, no framework) — pure JSON API, reads SQLite, inserts commands. Serves no HTML/static files — the admin-page UI is a separate project calling this API cross-origin (CORS reflects the caller's `Origin` dynamically; bearer-token auth, no cookies, so that's CSRF-safe). Loads `.env.admin` explicitly (`dotenv`'s `path` option, not the bare `dotenv/config` auto-import) into a private object (`processEnv: {}`) — a physically separate file from the bot's `.env.bot` is the primary defense (see README "Two env files"), the fileEnv indirection is defense in depth on top of that. [eslint.config.js](eslint.config.js) forbids `src/admin/**` from importing config/signer/redeem/executor/preflight/control/scan/viem/@polymarket — don't weaken it.
- Separate processes also keep admin HTTP work off the bot's event loop (latency matters). SQLite runs in WAL mode with `busy_timeout` for concurrent access.

[src/db.ts](src/db.ts) — schema + all read/write helpers, shared by both processes (must never import config.ts). Tables: `opportunities` (every detected opportunity + `reason`: dry-run | paused | below-execute-threshold | unsizeable | executed), `trades` (real executions: filled | both_failed | partial_unwound | partial_unwind_failed), `positions` (ledger: a `filled` trade upserts by conditionId; cleared by `markRedeemed`), `commands` (admin→bot queue), `kv` (`status` heartbeat, `settings` overrides). `summarize()` is the single P&L aggregation used by both `npm run analyze` and `/api/summary`.

[src/commands.ts](src/commands.ts) — `validateCommand()` for `set_config | pause | resume | stop | start | redeem`, run by the admin (early reject) **and** the bot (the real trust boundary). UI-settable `maxOrderSizeUsdc` capped at `MAX_ORDER_SIZE_CEILING_USDC`.

[src/control.ts](src/control.ts) — bot side: executes commands, rejects ones older than 60s (queued while the bot was down), writes status every 5s and right after each command. `set_config` re-runs `assertTradingReady()` whenever the result is live and rolls the whole patch back on failure. Admin-changed settings persist in `kv.settings` and **override `.env.bot`** at startup (`applySavedSettings`, logged).

**`stop`/`start` vs `pause`/`resume`** — deliberately different depths, both purely event-driven (no pm2/OS involvement was tried and reverted; see STRATEGY.md for why). `pause` (`config.paused`) is shallow: WS stays connected and scanning, only `executeArb()` skips real execution. `stop`/`start` (`config.running`) is deep: `control.ts` takes a `Lifecycle { onStop, onStart }` from `scan.ts` — `onStop` calls `store.close()` and clears the resync interval (tears the WS down entirely, only the 1s command poll survives to hear a future `start`); `onStart` reruns the whole `fetchActiveMarkets()` → `OrderbookStore` → `connect()` sequence from scratch and can throw (e.g. Gamma unreachable), which rolls `config.running` back via the same before/restore pattern as `set_config`. Persisted like every other setting, so a crash-restart (pm2's `autorestart`, its only remaining job) boots idle if an operator last stopped it — never silently reconnects against their wishes.

## Trading pipeline (bot process)

1. **Market discovery** ([src/markets.ts](src/markets.ts)) — Gamma API paginated by `offset` in pages of 100 (API silently caps at 100 regardless of `limit`); a non-2xx past an undocumented ceiling (~2100) is its end-of-results signal (logged at info). `clobTokenIds` is a JSON-encoded `[yes, no]` string; `negRisk` picks the redeem adapter.
2. **Orderbooks** ([src/orderbookStore.ts](src/orderbookStore.ts)) — one WS subscribed to all ~4200 tokens. **Measured: for a subscription this large the WS sends a `book` snapshot for only a handful of tokens; almost everything arrives as `price_change`.** So the store applies `price_change` level deltas (`price_changes[]` with per-change `asset_id`; older `changes[]` format also handled) and takes each change's server-computed `best_ask` as authoritative. Full snapshots come from REST `getOrderBooks` in batches of 500 (1000 fails) — loaded by `scan.ts` on every WS open and every 10 min. `booksSynced` in status shows coverage.
3. **Detection** ([src/scan.ts](src/scan.ts), [src/feeRate.ts](src/feeRate.ts)) — cheap raw-margin pre-filter, then `computeNetMargin()` subtracts the real per-market taker fee (`shares*feeRate*p*(1-p)` per leg, rate via `client.getFeeRateBps`, cached per token). Proceeds only if net margin > `config.minProfitMargin`. `inFlight` (by conditionId) prevents overlapping handling of one market.
4. **Sizing & execution** ([src/executor.ts](src/executor.ts)) — `sizeOpportunity()` = min(depth at *exactly* the ask price used for the margin on each leg, budget), 0 if below `min_order_size`; unknown depth ⇒ 0 ⇒ never trades on guessed liquidity. `executeArb()` records the opportunity with its skip reason, or executes: both legs as FOK market orders concurrently; a rejected order is `{success:false}` (resolved, not thrown) — `filled()` treats both as not-filled, including for the unwind sell. One leg filled ⇒ FOK sell to unwind. Two-tier gate: `isExecutable()` requires net margin ≥ `executeMarginThreshold` (thin margins are lost to faster bots from a ~250ms-RTT VPS); `config.paused` (runtime, admin-set) skips execution but keeps recording.

[src/preflight.ts](src/preflight.ts) — `assertTradingReady()`: no-op unless live; checks USDC.e balance and CLOB allowance ≥ `maxOrderSizeUsdc`.

[src/redeem.ts](src/redeem.ts) — on-chain `redeemPositions` via viem, costs POL (`checkPolBalance`). Adapter/collateral addresses are **deliberately not hardcoded** (docs referenced an unverifiable newer "pUSD" flow); they come from `.env.bot` and must be self-verified (README "Claiming winnings"). Never add default addresses.

[src/signer.ts](src/signer.ts) — viem `WalletClient` from the private key; clob-client v5 accepts it as `ClobSigner`. No `ethers` in this project.

[src/config.ts](src/config.ts) — runtime config, loads `.env.bot` explicitly (own `dotenv` call with `path`, not the bare auto-import — see README "Two env files"). `paused`/`running` are runtime-only.

## No UI in this repo

This repo is bot + admin API only. The admin-page UI is a **separate
project** that calls the admin API over HTTP (CORS-enabled, bearer-token
auth) from its own origin — a dev server during development, a static host
in production. There used to be a `web/` folder serving this from the same
process as the admin API; it was removed in favor of that separation. If
you're building that UI project: Polymarket's own Gamma/CLOB REST and its
market WebSocket are public and CORS-open, so live orderbook/market data
can be fetched directly from the browser without proxying through this API.

## Conventions

- ESM throughout (`"type": "module"` + `NodeNext`) — relative imports use explicit `.js` extensions.
- `PRIVATE_KEY` is a real wallet key — never log it, never commit `.env.bot`/`.env.admin`, never put it in `.env.admin`; `data/` (SQLite) is gitignored.

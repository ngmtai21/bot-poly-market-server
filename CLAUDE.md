# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Polymarket within-market arbitrage bot plus a web admin panel. For a binary market, if `YES ask + NO ask < 1` (after fees), buying both sides locks in a profit regardless of outcome. Live order placement is gated behind `config.enableTrading` (`ENABLE_TRADING=true` in `.env`, or toggled from the admin panel), off by default — dry-run records every opportunity to SQLite without trading. See README.md for operations, STRATEGY.md for the strategy walkthrough.

## Commands

```bash
npm run scan              # trading bot (process 1): live orderbooks -> detect -> execute; holds the key
npm run admin             # admin panel (process 2): HTTP API + static UI in web/; never loads the key
npm run setup-api-key     # one-time: derive CLOB API creds from PRIVATE_KEY, paste into .env
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
- **Admin** ([src/admin/server.ts](src/admin/server.ts), `node:http`, no framework) — reads SQLite, inserts commands, serves [web/](web/). Loads `.env` via `dotenv` into a private object (`processEnv: {}`) and keeps only `ADMIN_*`/`DB_PATH`, so the key never enters its environment. [eslint.config.js](eslint.config.js) forbids `src/admin/**` from importing config/signer/redeem/executor/preflight/control/scan/viem/@polymarket — don't weaken it.
- Separate processes also keep admin HTTP work off the bot's event loop (latency matters). SQLite runs in WAL mode with `busy_timeout` for concurrent access.

[src/db.ts](src/db.ts) — schema + all read/write helpers, shared by both processes (must never import config.ts). Tables: `opportunities` (every detected opportunity + `reason`: dry-run | paused | below-execute-threshold | unsizeable | executed), `trades` (real executions: filled | both_failed | partial_unwound | partial_unwind_failed), `positions` (ledger: a `filled` trade upserts by conditionId; cleared by `markRedeemed`), `commands` (admin→bot queue), `kv` (`status` heartbeat, `settings` overrides). `summarize()` is the single P&L aggregation used by both `npm run analyze` and `/api/summary`.

[src/commands.ts](src/commands.ts) — `validateCommand()` for `set_config | pause | resume | redeem`, run by the admin (early reject) **and** the bot (the real trust boundary). UI-settable `maxOrderSizeUsdc` capped at `MAX_ORDER_SIZE_CEILING_USDC`.

[src/control.ts](src/control.ts) — bot side: executes commands, rejects ones older than 60s (queued while the bot was down), writes status every 5s and right after each command. `set_config` re-runs `assertTradingReady()` whenever the result is live and rolls the whole patch back on failure. Admin-changed settings persist in `kv.settings` and **override .env** at startup (`applySavedSettings`, logged).

## Trading pipeline (bot process)

1. **Market discovery** ([src/markets.ts](src/markets.ts)) — Gamma API paginated by `offset` in pages of 100 (API silently caps at 100 regardless of `limit`); a non-2xx past an undocumented ceiling (~2100) is its end-of-results signal (logged at info). `clobTokenIds` is a JSON-encoded `[yes, no]` string; `negRisk` picks the redeem adapter.
2. **Orderbooks** ([src/orderbookStore.ts](src/orderbookStore.ts)) — one WS subscribed to all ~4200 tokens. **Measured: for a subscription this large the WS sends a `book` snapshot for only a handful of tokens; almost everything arrives as `price_change`.** So the store applies `price_change` level deltas (`price_changes[]` with per-change `asset_id`; older `changes[]` format also handled) and takes each change's server-computed `best_ask` as authoritative. Full snapshots come from REST `getOrderBooks` in batches of 500 (1000 fails) — loaded by `scan.ts` on every WS open and every 10 min. `booksSynced` in status shows coverage.
3. **Detection** ([src/scan.ts](src/scan.ts), [src/feeRate.ts](src/feeRate.ts)) — cheap raw-margin pre-filter, then `computeNetMargin()` subtracts the real per-market taker fee (`shares*feeRate*p*(1-p)` per leg, rate via `client.getFeeRateBps`, cached per token). Proceeds only if net margin > `config.minProfitMargin`. `inFlight` (by conditionId) prevents overlapping handling of one market.
4. **Sizing & execution** ([src/executor.ts](src/executor.ts)) — `sizeOpportunity()` = min(depth at *exactly* the ask price used for the margin on each leg, budget), 0 if below `min_order_size`; unknown depth ⇒ 0 ⇒ never trades on guessed liquidity. `executeArb()` records the opportunity with its skip reason, or executes: both legs as FOK market orders concurrently; a rejected order is `{success:false}` (resolved, not thrown) — `filled()` treats both as not-filled, including for the unwind sell. One leg filled ⇒ FOK sell to unwind. Two-tier gate: `isExecutable()` requires net margin ≥ `executeMarginThreshold` (thin margins are lost to faster bots from a ~250ms-RTT VPS); `config.paused` (runtime, admin-set) skips execution but keeps recording.

[src/preflight.ts](src/preflight.ts) — `assertTradingReady()`: no-op unless live; checks USDC.e balance and CLOB allowance ≥ `maxOrderSizeUsdc`.

[src/redeem.ts](src/redeem.ts) — on-chain `redeemPositions` via viem, costs POL (`checkPolBalance`). Adapter/collateral addresses are **deliberately not hardcoded** (docs referenced an unverifiable newer "pUSD" flow); they come from `.env` and must be self-verified (README "Claiming winnings"). Never add default addresses.

[src/signer.ts](src/signer.ts) — viem `WalletClient` from the private key; clob-client v5 accepts it as `ClobSigner`. No `ethers` in this project.

[src/config.ts](src/config.ts) — runtime config from `.env`; `required("PRIVATE_KEY")` throws at import, which is why the admin process must never import it. `paused` is runtime-only.

## Web UI ([web/](web/))

Plain ES module + CSS, no build step, served by the admin process under a strict CSP (`script-src 'self'`, no inline styles/scripts — set styles via CSSOM like `el.style.width`). All external data is rendered with `textContent` via the `h()` helper, never `innerHTML` — the page can enable live trading, so a crafted market title must not execute. The Markets tab talks to Polymarket directly from the browser (Gamma and CLOB are CORS `*`; WS is public) — the admin backend does not proxy market data.

## Conventions

- ESM throughout (`"type": "module"` + `NodeNext`) — relative imports use explicit `.js` extensions.
- `PRIVATE_KEY` is a real wallet key — never log it, never commit `.env`; `data/` (SQLite) is gitignored.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Polymarket within-market arbitrage bot. For a binary market, if `YES ask + NO ask < 1` (minus a margin buffer), buying both sides locks in a risk-free profit regardless of outcome. The bot detects opportunities and can place both legs automatically — gated behind `config.enableTrading` (`ENABLE_TRADING=true` in `.env`), which defaults to off (dry-run: opportunities are logged, no orders sent). See Status in README.md.

## Commands

```bash
npm run scan            # main entrypoint: connects to live orderbooks and logs arb opportunities
npm run setup-api-key   # one-time: derives CLOB API key/secret/passphrase from PRIVATE_KEY, paste into .env
npm run build           # tsc typecheck/compile to dist/
npm run lint            # eslint src
```

No test suite exists yet. Setup: `cp env.dist .env`, fill in `PRIVATE_KEY`, then run `setup-api-key` and paste the printed creds back into `.env`.

## Architecture

Three-stage pipeline, wired together in [src/scan.ts](src/scan.ts):

1. **Market discovery** ([src/markets.ts](src/markets.ts)) — `fetchActiveMarkets()` polls the public Gamma REST API once at startup for all active/open binary markets. Each market's `clobTokenIds` field is a JSON-encoded `[yesTokenId, noTokenId]` pair that has to be parsed.
2. **Live orderbook tracking** ([src/orderbookStore.ts](src/orderbookStore.ts)) — `OrderbookStore` opens a single WebSocket to Polymarket's CLOB market channel, subscribes to every token id from step 1, and maintains an in-memory book (bids/asks with size) per token. It only handles full `"book"` snapshot events; incremental `price_change` deltas are intentionally ignored (a snapshot is sufficient for a margin check). Reconnects automatically on close.
3. **Execution** ([src/executor.ts](src/executor.ts)) — `sizeOpportunity()` caps the trade at the smaller of: shares resting at the best ask on either leg, and `config.maxOrderSizeUsdc` worth of shares; returns 0 (skip) if that's below either leg's exchange-enforced `min_order_size` (from the orderbook, tracked per token in `OrderbookStore`/`Book.minOrderSize` — an order below it would just be rejected). `executeArb()` places both legs concurrently as fill-or-kill (`OrderType.FOK`) market orders via `createAndPostMarketOrder` — FOK means each leg either fills completely or not at all, so there's never a half-filled resting order to babysit. If exactly one leg fills (the other's FOK failed), the filled leg is immediately unwound with a best-effort FOK market sell; failure to unwind logs an error requiring manual intervention. All order placement is gated by `config.enableTrading` — false by default (dry-run, logs only).

**Fees are not priced into the margin calculation.** Polymarket charges a taker fee `fee = shares * feeRate * p * (1-p)`, feeRate up to 0.07 depending on market category (not exposed by the Gamma API), peaking near p=0.5 — the same region where YES+NO tends to be closest to 1. `MIN_PROFIT_MARGIN` (`env.dist` default `0.1`) is set as a blanket safety buffer above the worst-case fee rather than computing the real per-market fee, so it's intentionally conservative and will miss real opportunities on low-fee categories. Don't lower it without first sourcing the actual fee category per market.

[src/scan.ts](src/scan.ts) ties these together: it builds a `tokenId -> {conditionId, question, yesTokenId, noTokenId}` map so that when either leg of a market's book updates, it can look up the other leg, compute `margin = 1 - (yesAsk + noAsk)`, and — when `margin > config.minProfitMargin` — size and execute via the executor. An `inFlight` set keyed by `conditionId` prevents re-entering `executeArb` for a market while a previous attempt on it hasn't resolved yet.

This is event-driven (WebSocket push), not polling — the scan loop reacts to book updates rather than running on a REST interval.

[src/preflight.ts](src/preflight.ts) — `assertTradingReady()` runs once at scan startup (no-op if `enableTrading` is false). Checks USDC.e collateral balance and CLOB exchange allowance via `client.getBalanceAllowance`; throws before entering the scan loop if either is below `config.maxOrderSizeUsdc`, so a misconfigured/unfunded wallet fails fast instead of spamming failed orders once a real opportunity fires.

[src/config.ts](src/config.ts) is the single source of runtime config, read from `.env` via `dotenv`; `required()` throws immediately if `PRIVATE_KEY` is missing, since everything downstream depends on the wallet. `enableTrading` is the safety gate for real order placement — only `ENABLE_TRADING=true` (exact string) turns it on.

[src/scripts/setup-api-key.ts](src/scripts/setup-api-key.ts) is a standalone, run-once script (not part of the scan pipeline) that derives CLOB API credentials from the EOA private key via `@polymarket/clob-client`.

[src/paperTradeLog.ts](src/paperTradeLog.ts) — `recordPaperTrade()` appends one JSON line per dry-run opportunity to `paper-trades.jsonl` (gitignored). Only called from `executeArb()`'s `!config.enableTrading` branch. [src/scripts/analyze-paper-trades.ts](src/scripts/analyze-paper-trades.ts) (`npm run analyze`) reads that file and prints opportunity count, average margin, and total hypothetical profit — used in place of a historical backtest, since Polymarket doesn't expose historical orderbook depth to backtest against.

[src/logger.ts](src/logger.ts) is the shared logger (timestamp + level prefix) used everywhere except `setup-api-key.ts`, which prints raw credentials to stdout for copy-pasting.

## Conventions

- ESM throughout (`"type": "module"` + `NodeNext` resolution) — relative imports must use explicit `.js` extensions even though the source is `.ts` (see imports in scan.ts/markets.ts).
- `PRIVATE_KEY` is a real wallet key with fund access — never log it, never commit `.env`.

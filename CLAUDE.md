# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A read-only Polymarket arbitrage scanner. For a binary market, if `YES ask + NO ask < 1` (minus a margin buffer), buying both sides locks in a risk-free profit regardless of outcome. The bot detects and logs these opportunities; it does **not** place orders yet (see Status in README.md).

## Commands

```bash
npm run scan            # main entrypoint: connects to live orderbooks and logs arb opportunities
npm run setup-api-key   # one-time: derives CLOB API key/secret/passphrase from PRIVATE_KEY, paste into .env
npm run build           # tsc typecheck/compile to dist/
npm run lint            # eslint src
```

No test suite exists yet. Setup: `cp env.dist .env`, fill in `PRIVATE_KEY`, then run `setup-api-key` and paste the printed creds back into `.env`.

## Architecture

Two-stage pipeline, wired together in [src/scan.ts](src/scan.ts):

1. **Market discovery** ([src/markets.ts](src/markets.ts)) — `fetchActiveMarkets()` polls the public Gamma REST API once at startup for all active/open binary markets. Each market's `clobTokenIds` field is a JSON-encoded `[yesTokenId, noTokenId]` pair that has to be parsed.
2. **Live orderbook tracking** ([src/orderbookStore.ts](src/orderbookStore.ts)) — `OrderbookStore` opens a single WebSocket to Polymarket's CLOB market channel, subscribes to every token id from step 1, and maintains an in-memory best bid/ask per token. It only handles full `"book"` snapshot events; incremental `price_change` deltas are intentionally ignored (a snapshot is sufficient for a margin check). Reconnects automatically on close.

[src/scan.ts](src/scan.ts) ties these together: it builds a `tokenId -> {conditionId, question, yesTokenId, noTokenId}` map so that when either leg of a market's book updates, it can look up the other leg, compute `margin = 1 - (yesAsk + noAsk)`, and log when `margin > config.minProfitMargin`.

This is event-driven (WebSocket push), not polling — the scan loop reacts to book updates rather than running on a REST interval.

[src/config.ts](src/config.ts) is the single source of runtime config, read from `.env` via `dotenv`; `required()` throws immediately if `PRIVATE_KEY` is missing, since everything downstream depends on the wallet.

[src/scripts/setup-api-key.ts](src/scripts/setup-api-key.ts) is a standalone, run-once script (not part of the scan pipeline) that derives CLOB API credentials from the EOA private key via `@polymarket/clob-client`.

## Conventions

- ESM throughout (`"type": "module"` + `NodeNext` resolution) — relative imports must use explicit `.js` extensions even though the source is `.ts` (see imports in scan.ts/markets.ts).
- `PRIVATE_KEY` is a real wallet key with fund access — never log it, never commit `.env`.

---
name: polymarket-arb-bot
description: Context on the Polymarket within-market arbitrage scanner (bot-poly-market-server repo) — its arb strategy, pipeline architecture, and status. Use when discussing this bot, Polymarket YES/NO arbitrage, or work that touches its repo from another directory/session.
---

# Polymarket arbitrage bot

Repo: `bot-poly-market-server` (Node.js/TypeScript, ESM). Read-only scanner today —
does not place orders yet.

## The strategy

For a binary Polymarket market, if `YES ask + NO ask < 1` (minus a margin
buffer), buying both legs locks in a risk-free profit regardless of outcome.
The bot only detects and logs this; execution is deliberately not wired up
yet, pending validation of detected opportunities against real orderbooks.

## Pipeline

1. **Market discovery** (`src/markets.ts`) — one-shot poll of Polymarket's
   public Gamma REST API for active/open binary markets. Each market's
   `clobTokenIds` is a JSON-encoded `[yesTokenId, noTokenId]` string that
   must be parsed.
2. **Live orderbook tracking** (`src/orderbookStore.ts`) — a single
   WebSocket to Polymarket's CLOB market channel, subscribed to every token
   id from step 1, maintaining best bid/ask per token in memory. Only full
   `"book"` snapshots are handled; incremental `price_change` deltas are
   intentionally ignored (a snapshot suffices for a margin check).
   Reconnects automatically on close.
3. **Arb check** (`src/scan.ts`) — on every book update, looks up the
   sibling leg via a `tokenId -> market info` map, computes
   `margin = 1 - (yesAsk + noAsk)`, and logs when it exceeds
   `config.minProfitMargin`.

Event-driven (WS push), not interval polling.

## Config & credentials

`src/config.ts` reads `.env` via `dotenv`. `PRIVATE_KEY` is a real Polygon
EOA wallet key with fund access — required, never logged, never committed.
`npm run setup-api-key` derives CLOB API key/secret/passphrase from it via
`@polymarket/clob-client`, run once.

## Status

Market scanner and opportunity detector are done. Not yet built: order
execution (both legs, partial fills), position sizing vs. orderbook depth,
settlement/claim monitoring.

## Conventions

ESM + `NodeNext` resolution — relative imports use explicit `.js`
extensions even in `.ts` source.

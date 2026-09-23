# Polymarket arbitrage bot

Detects within-market arbitrage on Polymarket: for a binary market, if
`YES ask + NO ask < 1` (minus margin buffer), buying both sides locks in a
risk-free profit regardless of outcome.

## Setup

1. `cp env.dist .env` and fill in `PRIVATE_KEY` (your Polygon EOA wallet key,
   used to sign/derive API credentials — never commit this).
2. `npm install`
3. `npm run setup-api-key` — derives your CLOB API key/secret/passphrase and
   prints them; paste into `.env`.
4. Fund your Polymarket proxy wallet with USDC.e on Polygon (via
   polymarket.com deposit flow).

## Testing the pipeline without waiting for live data

```bash
npm run self-test
```

Runs the detection/sizing logic (`computeNetMargin`, `sizeOpportunity`)
against synthetic orderbook fixtures — verifies the math is correct in
seconds, without needing a live WebSocket connection or waiting for a real
opportunity. This is not a historical backtest (Polymarket doesn't expose
historical orderbook depth to backtest against — see Fees section); it only
proves the code's logic is correct, not that real opportunities are frequent
or profitable. Use `npm run status` / `npm run analyze` for that.

## Usage

```bash
npm run scan
```

Subscribes to live orderbooks and reacts to opportunities where
`margin > MIN_PROFIT_MARGIN`.

By default `ENABLE_TRADING=false` — the bot dry-runs (logs what it *would*
buy, places no orders) and appends each opportunity to `paper-trades.jsonl`.
Let it run for a while (hours/days), then:

```bash
npm run analyze
```

to see how many opportunities were sizeable and the total hypothetical
profit — this is the realistic substitute for a historical backtest, since
Polymarket doesn't expose historical orderbook depth. Set
`ENABLE_TRADING=true` in `.env` to let it trade for real, only after the
paper-trading numbers look worth it and after testing with a very small
`MAX_ORDER_SIZE_USDC`.

## Fees

Polymarket charges a taker fee (`shares * feeRate * p * (1-p)`, feeRate up to
7% depending on market category, peaking near p=0.5 — right where YES+NO
tends to sit near 1). The bot fetches each market's real fee rate via the
CLOB API and subtracts the expected fee before comparing against
`MIN_PROFIT_MARGIN` (default `0.01`) — so the threshold only needs to cover
slippage/execution risk, not the fee itself.

## Status

- [x] Market scanner (Gamma API)
- [x] Opportunity detector (within-market YES/NO spread)
- [x] Order execution (both legs as FOK market orders, gated by `ENABLE_TRADING`)
- [x] Position sizing vs orderbook depth
- [x] Balance/allowance checks before trading
- [x] Min order size enforcement (skips opportunities below exchange minimum)
- [x] Fee-aware margin threshold (real per-market fee via `getFeeRateBps`)
- [x] Zero known dependency vulnerabilities (`@polymarket/clob-client` v5 + `viem`, no `ethers`)
- [ ] Persisted trade/opportunity history (for reporting)
- [ ] Settlement/claim monitoring
- [ ] Circuit breaker on repeated failures

Partial fills are handled by unwinding the filled leg with a best-effort
market sell — this reduces but does not eliminate directional risk if the
market moves in the few seconds between legs. Start with real trading
disabled and a tiny `MAX_ORDER_SIZE_USDC` before trusting this with capital.

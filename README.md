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

## Usage

```bash
npm run scan
```

Read-only: polls active markets every 15s and logs opportunities where
`margin > MIN_PROFIT_MARGIN`. Does not place orders yet.

## Status

- [x] Market scanner (Gamma API)
- [x] Opportunity detector (within-market YES/NO spread)
- [ ] Order execution (place both legs, handle partial fills)
- [ ] Position sizing vs orderbook depth
- [ ] Settlement/claim monitoring

Execution is intentionally not wired up yet — validate the detector's
opportunities against real orderbooks for a while before risking capital.

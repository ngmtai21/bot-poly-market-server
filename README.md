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
7-10% observed depending on market category, peaking near p=0.5 — right
where YES+NO tends to sit near 1). The bot fetches each market's real fee
rate via the CLOB API and subtracts the expected fee before comparing
against `MIN_PROFIT_MARGIN` — so the threshold only needs to cover
slippage/execution risk, not the fee itself.

## Two-tier margin strategy

This bot is not the fastest participant in the arb race — measured ~250ms
network RTT to Polymarket's infra from a non-US VPS (see Backlog). A thin
margin is likely to be eaten by slippage or a faster competing bot before an
order lands. So there are two separate thresholds:

- `MIN_PROFIT_MARGIN` (default `0.01`) — the "worth logging" bar. Anything
  above this is recorded to `paper-trades.jsonl`, so you can see true
  opportunity frequency even for margins too thin to safely trade.
- `EXECUTE_MARGIN_THRESHOLD` (default `0.05`) — the "worth actually risking
  capital" bar. Only opportunities at or above this are ever executed, even
  with `ENABLE_TRADING=true`. Opportunities between the two thresholds are
  recorded with `reason: "below-execute-threshold"` but never traded.

Raise `EXECUTE_MARGIN_THRESHOLD` further if `npm run analyze` shows real
trades still losing to faster bots at 5%; lower it (carefully) only once
infra latency is addressed.

## Claiming winnings

After a market resolves, payout isn't automatic — winning outcome tokens
must be redeemed via an on-chain transaction (`redeemPositions` on
Polymarket's CTF collateral adapter contract), separate from the CLOB order
API entirely. This costs POL (Polygon's gas token), not USDC.e.

```bash
npm run redeem -- <conditionId> [--neg-risk]
```

**You must supply the contract addresses yourself** in `.env`
(`CTF_ADAPTER_ADDRESS`, `NEG_RISK_CTF_ADAPTER_ADDRESS`,
`COLLATERAL_TOKEN_ADDRESS`) — they are deliberately left blank in
`env.dist`. Cross-referencing docs.polymarket.com and Polymarket's public
GitHub did not produce a single address confirmable with confidence (the
docs reference a newer "pUSD" wrapping flow that may not match the USDC.e
flow this bot otherwise uses). **Do not paste an address from an AI
response, a random blog post, or an unverified webpage** — a wrong contract
address can burn your outcome tokens with no payout, and this is not
reversible.

How to verify the addresses yourself, safest to least-safe:
1. **Best**: manually redeem one resolved position via the polymarket.com
   UI yourself, then look up that transaction on
   [polygonscan.com](https://polygonscan.com). The "To" address is the
   correct adapter contract for that market's type (standard vs neg-risk);
   the token received is the correct `COLLATERAL_TOKEN_ADDRESS`.
2. Cross-check against Polymarket's official GitHub repos
   (`Polymarket/conditional-tokens-contracts` and related) and their
   official Discord/support if the above isn't conclusive.

This script also checks the wallet's POL balance before submitting (a
redeem transaction can't be signed/paid for without it) and exits with a
clear error if it's 0.

`npm run redeem` is a **manual, single-market trigger** — the bot does not
yet auto-detect resolved markets it holds positions in. That needs a
persisted position ledger, which doesn't exist yet (see Backlog).

## Status

- [x] Market scanner (Gamma API)
- [x] Opportunity detector (within-market YES/NO spread)
- [x] Order execution (both legs as FOK market orders, gated by `ENABLE_TRADING`)
- [x] Position sizing vs orderbook depth
- [x] Balance/allowance checks before trading
- [x] Min order size enforcement (skips opportunities below exchange minimum)
- [x] Fee-aware margin threshold (real per-market fee via `getFeeRateBps`)
- [x] Zero known dependency vulnerabilities (`@polymarket/clob-client` v5 + `viem`, no `ethers`)
- [x] Full market coverage via Gamma API pagination (~2100 markets, was capped at 100)
- [x] Liquidity/volume tracked per opportunity (`liquidityNum`/`volumeNum` in `paper-trades.jsonl`) for correlating opportunity frequency with market thinness
- [x] Two-tier margin strategy — separate "log" vs "execute" thresholds (`MIN_PROFIT_MARGIN` / `EXECUTE_MARGIN_THRESHOLD`), so thin margins the bot can't realistically win are recorded but never traded
- [x] Manual redeem/claim script (`npm run redeem`) — on-chain `redeemPositions` call; contract addresses are self-verified (see "Claiming winnings"), not hardcoded, and POL gas balance is checked first
- [ ] Persisted trade/opportunity history (for reporting)
- [ ] Automatic settlement/claim monitoring (needs a position ledger — see Backlog)
- [ ] Circuit breaker on repeated failures

Partial fills are handled by unwinding the filled leg with a best-effort
market sell — this reduces but does not eliminate directional risk if the
market moves in the few seconds between legs. Start with real trading
disabled and a tiny `MAX_ORDER_SIZE_USDC` before trusting this with capital.

## Backlog — noted for later, not yet done

**Infra (biggest lever, not code):**
- [ ] Move VPS to US East (near Polymarket's Cloudflare-fronted infra) — measured
      ~250ms RTT from current location; est. drops to ~10-30ms once relocated.
      Test candidate providers (Vultr/DigitalOcean/Linode/AWS) with the curl timing
      command before committing to monthly billing (see conversation history).

**Reliability:**
- [ ] Circuit breaker — stop the bot after N consecutive execution failures
      instead of retrying indefinitely (e.g. wrong response shape, repeated
      network errors).
- [ ] Verify `createAndPostMarketOrder`'s real response shape end-to-end —
      only ever exercised via `createOrder` (local signing, no submit) in
      integration-test.ts. The actual submit/fill path is unverified until a
      real trade happens; response-shape assumptions in `executor.ts`
      (`.success !== false`) are confirmed correct per docs but never
      observed from an actual fill/reject.
- [ ] Automatic settlement/claim monitoring — `npm run redeem` exists but is
      manual/single-market. Full automation needs a persisted position
      ledger (which market/conditionId/shares the bot currently holds) that
      doesn't exist yet, so the bot can detect "this resolved and I'm
      holding tokens for it" on its own instead of you tracking it manually.

**Analysis / strategy validation:**
- [ ] Let paper-trading run 24h+, then `npm run analyze` — the actual
      blocking step before any real-trading decision.
- [ ] Once there's opportunity data, check the liquidity/volume correlation
      `analyze-paper-trades.ts` now prints — confirms or refutes the
      "low-liquidity markets are less competed-over" hypothesis discussed.

**Explicitly decided against (don't redo without new evidence):**
- Rewriting in Go/Rust — bottleneck is network RTT (~250ms), not code
  execution speed (measured <5ms overhead); not worth the engineering cost
  of losing the official SDK unless VPS relocation still leaves Node.js as
  a measurable bottleneck.
- Worker threads / splitting the scan — bot is I/O-bound, not CPU-bound;
  per-event processing is sub-millisecond even across ~4200 subscribed
  tokens. No evidence of a WS subscription limit either.
- Per-market fee category guessing — superseded by fetching the real fee
  rate via `client.getFeeRateBps()`.

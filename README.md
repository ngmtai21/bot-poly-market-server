# Polymarket arbitrage bot

Detects within-market arbitrage on Polymarket: for a binary market, if
`YES ask + NO ask < 1` (after fees), buying both sides locks in a profit
regardless of outcome. Includes a web admin panel to monitor and control it.

See [STRATEGY.md](STRATEGY.md) for a diagrammed walkthrough of the pipeline
and the reasoning behind it.

## Setup

1. `cp env.dist .env` and fill in `PRIVATE_KEY` (Polygon EOA wallet key —
   never commit this) and `ADMIN_TOKEN` (see below).
2. `npm install`
3. `npm run setup-api-key` — derives CLOB API key/secret/passphrase; paste
   into `.env`.
4. For live trading only: fund the Polymarket proxy wallet with USDC.e and
   keep some POL for gas (needed to redeem).

## Running

Two separate processes, sharing one SQLite file (`data/bot.db`):

```bash
pm2 start "npm run scan"  --name polymarket-bot     # trading bot — holds the key
pm2 start "npm run admin" --name polymarket-admin   # admin panel — never loads the key
pm2 save
```

They're separate on purpose: the admin's HTTP traffic can't slow the bot's
event loop, and a compromised web layer can't reach the wallet key. The
admin only queues commands in SQLite; the bot re-validates and executes
them.

**The bot's speed is never traded off for the admin panel.** Two separate
Node processes means separate event loops — admin HTTP handling cannot
delay the bot's WS message processing regardless of load. At the SQLite
layer (WAL mode), this was measured directly: a reader hammering
`summarize()` in a tight loop (~5000 calls/sec — far past anything the
5s-polling UI generates) left the bot's write latency unchanged (p99
0.33ms → 0.31ms). `npm run scan` also runs at a higher OS scheduling
priority than `npm run admin` (`nice -n -5` vs `-n 10` — needs root, which
the VPS runs as; degrades harmlessly to normal priority otherwise) as a
belt-and-suspenders guarantee under CPU pressure.

## Admin panel

- Generate a token and put it in `.env` as `ADMIN_TOKEN` (≥ 24 chars):
  `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
- It binds to `127.0.0.1:8787` by default — **don't expose it publicly**.
  From your laptop: `ssh -L 8787:127.0.0.1:8787 root@<vps>` then open
  http://localhost:8787.

Tabs:
- **Dashboard** — P&L, opportunity counts by reason, bot health (heartbeat,
  WS, books synced), and controls: enable/disable live trading, pause/resume,
  change thresholds and order size.
- **Markets** — top 500 markets by 24h volume and a live YES/NO orderbook,
  loaded straight from Polymarket's public API/WebSocket by the browser.
- **Opportunities / Trades / Positions / Commands** — everything the bot has
  recorded; positions have a Redeem button once markets resolve.

Control safety: enabling live trading requires typing `ENABLE` and passes the
same balance/allowance preflight as startup (rolled back if it fails); order
size is capped at $1000 from the UI; commands expire after 60s so a click
made while the bot was down never fires hours later. Settings changed from
the panel persist across restarts and **override `.env`** (logged at startup).

## Checking the pipeline

```bash
npm run self-test         # logic: margin/fee/sizing, ledger math, command validation
npm run integration-test  # live network + local order signing (nothing submitted)
npm run status            # is the bot alive, what has it seen
npm run analyze           # full summary (same numbers as the dashboard)
```

There's no historical backtest — Polymarket doesn't expose historical
orderbook depth. Dry-run (`ENABLE_TRADING=false`, the default) is the
substitute: every opportunity is recorded with why it wasn't traded.

## Fees

Taker fee is `shares * feeRate * p * (1-p)` per leg, feeRate per market (up
to ~10% observed), peaking near p=0.5. The bot fetches each market's real
rate and subtracts it before comparing against the thresholds.

## Two-tier margin strategy

- `MIN_PROFIT_MARGIN` (default `0.01`) — "worth recording". Shows true
  opportunity frequency even for margins too thin to trade.
- `EXECUTE_MARGIN_THRESHOLD` (default `0.05`) — "worth risking capital".
  From a non-US VPS (~250ms RTT) a thin margin is usually gone before the
  order lands. Between the two thresholds: recorded as
  `below-execute-threshold`, never traded.

## Claiming winnings

Payout after resolution isn't automatic — winning tokens are redeemed with an
on-chain `redeemPositions` call (costs POL). Use the Redeem button in the
Positions tab, or `npm run redeem -- <conditionId> [--neg-risk]`.

**You must supply the contract addresses yourself** (`CTF_ADAPTER_ADDRESS`,
`NEG_RISK_CTF_ADAPTER_ADDRESS`, `COLLATERAL_TOKEN_ADDRESS`); they're blank
in `env.dist` on purpose. Docs cross-referencing didn't yield an address
confirmable with confidence (docs mention a newer "pUSD" flow). **Don't
paste an address from an AI response or an unverified webpage** — a wrong
one can burn your tokens irreversibly. Safest way: redeem one resolved
position manually on polymarket.com, open that tx on polygonscan.com — the
"To" address is the adapter for that market type; the token received is the
collateral.

## Status

- [x] Full market coverage (~2100 markets via paginated Gamma API)
- [x] Live orderbooks: WS `price_change` deltas + REST snapshots (on connect, every 10 min)
- [x] Fee-aware net margin, two-tier thresholds, depth/min-order-size sizing
- [x] Execution: both legs FOK, partial fill unwound, gated by `ENABLE_TRADING`
- [x] Balance/allowance preflight (startup and on every live config change)
- [x] SQLite ledger: opportunities, trades, positions, commands, settings
- [x] Admin panel with controls, live orderbook viewer, redeem
- [x] Zero known dependency vulnerabilities
- [ ] Automatic redeem when a held market resolves (manual button for now)
- [ ] Circuit breaker on repeated failures

## Backlog

**Infra (biggest lever):**
- [ ] Move VPS to US East — ~250ms RTT today; est. ~10-30ms after. Test
      candidates with
      `curl -s -o /dev/null -w "%{time_starttransfer}\n" https://clob.polymarket.com/`
      before committing.

**Reliability:**
- [ ] Circuit breaker — stop after N consecutive execution failures.
- [ ] Observe a real `createAndPostMarketOrder` fill/reject — the `.success`
      handling matches docs but has never seen a live response.
- [ ] Auto-redeem: watch Gamma for resolution of markets in `positions`,
      queue a redeem command.

**Strategy validation:**
- [ ] Let dry-run collect data 24h+ (on the US VPS), then check the
      dashboard: frequency above 5%, and whether opportunities skew toward
      low-liquidity markets.

**Decided against (don't redo without new evidence):**
- Go/Rust rewrite — bottleneck is network RTT, not code (<5ms overhead measured).
- Worker threads — bot is I/O-bound; per-event work is sub-millisecond.
- Guessing fee by category — superseded by `client.getFeeRateBps()`.
- React/Vite for the admin UI — three static files, no build step; revisit
  if the UI grows substantially.

# Notes for building an admin/report page later

Not built yet — this is context capture for whoever (or whichever future
session) builds it, so the design doesn't have to be re-derived from scratch.

## What data already exists to build on

- **`paper-trades.jsonl`** (gitignored, lives next to wherever `npm run scan`
  runs — e.g. on the VPS) — one JSON line per detected opportunity, whether
  dry-run or live-but-below-`EXECUTE_MARGIN_THRESHOLD`. Fields per entry:
  `ts`, `conditionId`, `question`, `yesAsk`, `noAsk`, `margin`, `shares`,
  `expectedProfitUsdc`, `liquidityNum`, `volumeNum`, `reason`
  (`"dry-run"` | `"below-execute-threshold"`).
- **Real executed trades** are currently only `logger.info`'d to stdout
  (captured by `pm2 logs` / `pm2`'s log files on the VPS) — **not persisted
  as structured data**. This is the single biggest gap before an admin page
  is useful: there's no queryable record of real trades, P&L, or open
  positions. See "Needed before the admin page is useful" below.
- **`pm2 status` / `pm2 show polymarket-bot`** — process uptime, restart
  count, memory. Could be surfaced via SSH/API if the admin page needs
  process health, not just trading data.

## What the admin page would plausibly need to show

1. **Bot status**: running/stopped, uptime, dry-run vs live mode
   (`ENABLE_TRADING`), current thresholds (`MIN_PROFIT_MARGIN`,
   `EXECUTE_MARGIN_THRESHOLD`, `MAX_ORDER_SIZE_USDC`).
2. **Opportunity feed**: recent entries from `paper-trades.jsonl`, filterable
   by `reason`, sortable by margin/liquidity/time.
3. **P&L**: total hypothetical profit (dry-run) vs total real profit (once
   real trades are persisted — not yet).
4. **Open positions**: markets currently holding YES+NO tokens, not yet
   resolved/redeemed — needs the position ledger (see below).
5. **Liquidity/volume correlation**: chart of opportunity margin vs
   `liquidityNum`/`volumeNum`, to visually validate the "low-liquidity
   markets are less competed-over" hypothesis (see README).
6. **Config editor**: change `MIN_PROFIT_MARGIN` / `EXECUTE_MARGIN_THRESHOLD`
   / `MAX_ORDER_SIZE_USDC` / `ENABLE_TRADING` from the UI instead of SSHing
   in to edit `.env` + `pm2 restart`.
7. **Redeem panel**: trigger `npm run redeem -- <conditionId>` from the UI
   for resolved markets, once a position ledger exists to know what's
   redeemable.

## Needed before the admin page is useful (do these first)

These are prerequisites, not admin-page work itself:

1. **Persist real trade outcomes** — right now `executeArb()`'s live-trading
   branch (`src/executor.ts`) only logs to `logger`, doesn't write anything
   structured. Needs the same treatment as `recordPaperTrade()`: write real
   fills/failures/unwinds to a file or (more appropriate at this point) a
   real database, since an admin page querying a growing JSONL file by hand
   won't scale well.
2. **Position ledger** — track conditionId → shares held → resolved? →
   redeemed? across the trade lifecycle. Doesn't exist yet. This is also
   what full automatic redemption (see README backlog) depends on, so it's
   worth building once for both.
3. **Pick a real datastore** — JSONL append-only files were the pragmatic
   choice for a single-process bot logging to itself, but an admin page
   implies a second consumer reading concurrently, filtering, and
   aggregating — SQLite (still zero-ops, no server) is the natural next step
   over continuing to hand-parse JSONL in the report scripts.
4. **Expose data over HTTP** — the admin page needs an API to talk to,
   whether that's the bot process itself exposing a small read-only HTTP
   endpoint, or a separate reader process pointed at the same SQLite file.

## Constraints/decisions already made that the admin page should respect

- **Never handle `PRIVATE_KEY` or wallet secrets in a web-facing process.**
  If the admin page needs to trigger actions (redeem, config changes), keep
  the actual signing/trading process separate from anything with a public or
  browser-facing surface — e.g. the admin backend writes a request the bot
  process picks up, rather than the admin backend importing `signer.ts`
  directly and holding the key itself.
- `.env` is the source of truth for config and is gitignored — a config
  editor UI should write to `.env` (or a config store the bot reads from),
  not commit secrets anywhere reachable by the web layer.
- The bot runs on a VPS via `pm2` — the admin page's data source will
  either need to run on/reach that same VPS, or the VPS needs to push data
  somewhere the admin page can reach (e.g. periodic sync, or a lightweight
  API the admin page polls).

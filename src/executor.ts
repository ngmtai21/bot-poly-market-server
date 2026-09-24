import type { ClobClient } from "@polymarket/clob-client";
import { OrderType, Side } from "@polymarket/clob-client";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { recordOpportunity, recordTrade, type Db, type OpportunityReason } from "./db.js";
import type { Book } from "./orderbookStore.js";

export interface ArbOpportunity {
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  yesAsk: number;
  noAsk: number;
  margin: number;
  liquidityNum?: number;
  volumeNum?: number;
  negRisk?: boolean;
}

// Shares resting at exactly the ask price the margin was computed from. If
// the book hasn't synced that level yet, this is 0 and the trade is skipped
// — never size an order off depth we don't actually know.
function depthAt(book: Book, price: number): number {
  return book.asks.filter((a) => a.price === price).reduce((sum, a) => sum + a.size, 0);
}

// Caps the trade so it never buys more shares than are actually resting at
// the best ask on either leg, and never exceeds the configured USDC budget.
// Returns 0 if the resulting size would be below either leg's exchange-
// enforced minimum order size (the FOK order would just be rejected).
export function sizeOpportunity(opp: ArbOpportunity, yesBook: Book, noBook: Book): number {
  const yesDepth = depthAt(yesBook, opp.yesAsk);
  const noDepth = depthAt(noBook, opp.noAsk);
  const budgetShares = config.maxOrderSizeUsdc / (opp.yesAsk + opp.noAsk);
  const shares = Math.min(yesDepth, noDepth, budgetShares);

  const minRequired = Math.max(yesBook.minOrderSize, noBook.minOrderSize);
  if (minRequired > 0 && shares < minRequired) return 0;
  return shares;
}

async function buyFok(client: ClobClient, tokenId: string, price: number, usdcAmount: number) {
  return client.createAndPostMarketOrder(
    { tokenID: tokenId, price, amount: usdcAmount, side: Side.BUY },
    undefined,
    OrderType.FOK
  );
}

async function sellFok(client: ClobClient, tokenId: string, shares: number) {
  return client.createAndPostMarketOrder(
    { tokenID: tokenId, amount: shares, side: Side.SELL },
    undefined,
    OrderType.FOK
  );
}

// Two-tier strategy: an opportunity can clear the (low) logging threshold in
// scan.ts but still be too thin to safely trade — this bot isn't the fastest
// in the race, so a small margin is likely eaten by slippage/latency before
// the order lands. Only margins at or above this bar are ever executed.
export function isExecutable(margin: number): boolean {
  return margin >= config.executeMarginThreshold;
}

// The CLOB reports a rejected order as a resolved `{ success: false }`
// rather than a thrown error, so both must count as "not filled".
function filled(r: PromiseSettledResult<{ success?: boolean } | undefined>): boolean {
  return r.status === "fulfilled" && r.value?.success !== false;
}

function outcome(r: PromiseSettledResult<unknown>): unknown {
  return r.status === "fulfilled" ? r.value : String(r.reason);
}

// Every opportunity lands in the `opportunities` table with the reason it
// was or wasn't traded; real executions additionally land in `trades` (and
// `positions` when both legs fill).
export async function executeArb(client: ClobClient, db: Db, opp: ArbOpportunity, shares: number): Promise<void> {
  const record = (reason: OpportunityReason) =>
    recordOpportunity(db, { ...opp, shares, reason });

  const skipReason: OpportunityReason | null = !config.enableTrading
    ? "dry-run"
    : config.paused
      ? "paused"
      : !isExecutable(opp.margin)
        ? "below-execute-threshold"
        : shares <= 0
          ? "unsizeable"
          : null;

  if (skipReason) {
    logger.info(`[${skipReason.toUpperCase()}] would buy`, { question: opp.question, shares, margin: opp.margin });
    record(skipReason);
    return;
  }
  record("executed");

  // Buys both legs concurrently as fill-or-kill market orders — each fills
  // completely or not at all, so there's never a half-filled resting order.
  const yesSpend = shares * opp.yesAsk;
  const noSpend = shares * opp.noAsk;
  const [yesResult, noResult] = await Promise.allSettled([
    buyFok(client, opp.yesTokenId, opp.yesAsk, yesSpend),
    buyFok(client, opp.noTokenId, opp.noAsk, noSpend),
  ]);
  const yesFilled = filled(yesResult);
  const noFilled = filled(noResult);
  const trade = { ...opp, negRisk: opp.negRisk ?? false, shares, yesSpend, noSpend };
  const legs = { yes: outcome(yesResult), no: outcome(noResult) };

  if (yesFilled && noFilled) {
    logger.info("Arb executed", { question: opp.question, shares, yesSpend, noSpend });
    recordTrade(db, { ...trade, status: "filled", detail: legs });
    return;
  }

  if (!yesFilled && !noFilled) {
    logger.warn("Both legs failed, no position taken", { question: opp.question, ...legs });
    recordTrade(db, { ...trade, status: "both_failed", detail: legs });
    return;
  }

  // Exactly one leg filled — we're holding a directional position we never
  // wanted. Unwind it immediately; best-effort market sell, not a guarantee
  // (the market can move against us in the meantime).
  const filledLeg = yesFilled ? { tokenId: opp.yesTokenId, side: "YES" } : { tokenId: opp.noTokenId, side: "NO" };
  logger.error("Partial fill on arb legs, unwinding filled side", { question: opp.question, filled: filledLeg.side });

  const [unwind] = await Promise.allSettled([sellFok(client, filledLeg.tokenId, shares)]);
  if (filled(unwind)) {
    logger.warn("Unwound partial fill", { question: opp.question, side: filledLeg.side });
    recordTrade(db, { ...trade, status: "partial_unwound", detail: { ...legs, filledSide: filledLeg.side, unwind: outcome(unwind) } });
  } else {
    logger.error("Failed to unwind partial fill — manual intervention required", {
      question: opp.question,
      side: filledLeg.side,
      tokenId: filledLeg.tokenId,
      shares,
      unwind: outcome(unwind),
    });
    recordTrade(db, {
      ...trade,
      status: "partial_unwind_failed",
      detail: { ...legs, filledSide: filledLeg.side, tokenId: filledLeg.tokenId, unwind: outcome(unwind) },
    });
  }
}

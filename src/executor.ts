import type { ClobClient } from "@polymarket/clob-client";
import { OrderType, Side } from "@polymarket/clob-client";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { recordPaperTrade } from "./paperTradeLog.js";
import type { Book } from "./orderbookStore.js";

export interface ArbOpportunity {
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  yesAsk: number;
  noAsk: number;
  margin: number;
}

// Size (in shares) available at the best ask level.
function depthAtBestAsk(book: Book | undefined): number {
  if (!book || !book.asks.length) return 0;
  const bestPrice = Math.min(...book.asks.map((a) => a.price));
  return book.asks.filter((a) => a.price === bestPrice).reduce((sum, a) => sum + a.size, 0);
}

// Caps the trade so it never buys more shares than are actually resting at
// the best ask on either leg, and never exceeds the configured USDC budget.
// Returns 0 if the resulting size would be below either leg's exchange-
// enforced minimum order size (the FOK order would just be rejected).
export function sizeOpportunity(opp: ArbOpportunity, yesBook: Book, noBook: Book): number {
  const yesDepth = depthAtBestAsk(yesBook);
  const noDepth = depthAtBestAsk(noBook);
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

// Buys both legs of a within-market arb concurrently as fill-or-kill market
// orders (each either fills completely or not at all — no dangling partial
// fills to manage mid-flight). If exactly one leg fills, the position is
// directional and gets unwound with a best-effort market sell.
export async function executeArb(client: ClobClient, opp: ArbOpportunity, shares: number): Promise<void> {
  if (!config.enableTrading) {
    logger.info("[DRY-RUN] would buy", { question: opp.question, shares, margin: opp.margin });
    recordPaperTrade({
      conditionId: opp.conditionId,
      question: opp.question,
      yesAsk: opp.yesAsk,
      noAsk: opp.noAsk,
      margin: opp.margin,
      shares,
      expectedProfitUsdc: shares * opp.margin,
    });
    return;
  }
  if (shares <= 0) {
    logger.warn("Skipping opportunity, zero sizeable shares", { question: opp.question });
    return;
  }

  const yesSpend = shares * opp.yesAsk;
  const noSpend = shares * opp.noAsk;

  const [yesResult, noResult] = await Promise.allSettled([
    buyFok(client, opp.yesTokenId, opp.yesAsk, yesSpend),
    buyFok(client, opp.noTokenId, opp.noAsk, noSpend),
  ]);

  const yesFilled = yesResult.status === "fulfilled" && yesResult.value?.success !== false;
  const noFilled = noResult.status === "fulfilled" && noResult.value?.success !== false;

  if (yesFilled && noFilled) {
    logger.info("Arb executed", { question: opp.question, shares, yesSpend, noSpend });
    return;
  }

  if (!yesFilled && !noFilled) {
    logger.warn("Both legs failed, no position taken", { question: opp.question, yesResult, noResult });
    return;
  }

  // Exactly one leg filled — we're now holding a directional position we
  // never wanted. Unwind it immediately; this is a best-effort market sell,
  // not a guarantee (the market can move against us in the meantime).
  const filledLeg = yesFilled ? { tokenId: opp.yesTokenId, side: "YES" } : { tokenId: opp.noTokenId, side: "NO" };
  logger.error("Partial fill on arb legs, unwinding filled side", { question: opp.question, filled: filledLeg.side });

  try {
    await sellFok(client, filledLeg.tokenId, shares);
    logger.warn("Unwound partial fill", { question: opp.question, side: filledLeg.side });
  } catch (err) {
    logger.error("Failed to unwind partial fill — manual intervention required", {
      question: opp.question,
      side: filledLeg.side,
      tokenId: filledLeg.tokenId,
      shares,
      err,
    });
  }
}

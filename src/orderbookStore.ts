import WebSocket from "ws";
import { logger } from "./logger.js";

export interface BookLevel {
  price: number;
  size: number;
}

export interface Book {
  bids: BookLevel[];
  asks: BookLevel[];
  minOrderSize: number;
}

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

function bestAsk(book: Book | undefined): number | null {
  if (!book || !book.asks.length) return null;
  return Math.min(...book.asks.map((a) => a.price));
}

// Maintains live orderbooks for a set of token ids via Polymarket's public
// market WebSocket channel, and calls `onUpdate` whenever a book changes.
export class OrderbookStore {
  private books = new Map<string, Book>();
  private ws: WebSocket | null = null;
  private tokenIds: string[];
  private onUpdate: (tokenId: string) => void;

  constructor(tokenIds: string[], onUpdate: (tokenId: string) => void) {
    this.tokenIds = tokenIds;
    this.onUpdate = onUpdate;
  }

  getBestAsk(tokenId: string): number | null {
    return bestAsk(this.books.get(tokenId));
  }

  getBook(tokenId: string): Book | undefined {
    return this.books.get(tokenId);
  }

  connect(): void {
    this.ws = new WebSocket(WS_URL);

    this.ws.on("open", () => {
      this.ws!.send(JSON.stringify({ type: "market", assets_ids: this.tokenIds }));
    });

    this.ws.on("message", (raw: Buffer) => {
      const events = JSON.parse(raw.toString());
      for (const event of Array.isArray(events) ? events : [events]) {
        this.handleEvent(event);
      }
    });

    this.ws.on("close", () => {
      setTimeout(() => this.connect(), 2000);
    });

    this.ws.on("error", (err) => {
      logger.error("Orderbook WS error", err.message);
    });
  }

  private handleEvent(event: Record<string, unknown>): void {
    if (event.event_type === "book") {
      const tokenId = event.asset_id as string;
      const levels = (arr: unknown) =>
        ((arr as { price: string; size: string }[]) ?? []).map((l) => ({
          price: Number(l.price),
          size: Number(l.size),
        }));
      this.books.set(tokenId, {
        bids: levels(event.bids),
        asks: levels(event.asks),
        minOrderSize: Number(event.min_order_size ?? 0),
      });
      this.onUpdate(tokenId);
    }
    // price_change events give incremental deltas; full "book" snapshots are
    // sufficient for a margin check, so incremental merging is skipped for now.
  }

  close(): void {
    this.ws?.close();
  }
}

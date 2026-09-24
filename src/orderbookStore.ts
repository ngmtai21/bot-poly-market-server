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

interface RawLevel {
  price: string;
  size: string;
}

interface Levels {
  bids: Map<string, number>;
  asks: Map<string, number>;
  minOrderSize: number;
  // Authoritative best ask: from the server's own best_ask on every
  // price_change, or computed from a full snapshot. Kept separately because
  // until a snapshot lands, `asks` only holds the levels that changed since
  // we subscribed — its minimum would be wrong.
  bestAsk: number | null;
  synced: boolean;
}

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

// "0.720" and "0.72" must hit the same level.
const key = (price: string | number) => String(Number(price));
const positiveOrNull = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function minAsk(asks: Map<string, number>): number | null {
  let best: number | null = null;
  for (const p of asks.keys()) if (best === null || Number(p) < best) best = Number(p);
  return best;
}

// Maintains live orderbooks for a set of token ids via Polymarket's public
// market WebSocket channel, and calls `onUpdate` whenever a token's book
// changes.
//
// Measured: subscribing ~4200 tokens on one socket yields a `book` snapshot
// for only a handful of them — nearly everything arrives as incremental
// `price_change` events. So deltas must be applied, and full snapshots are
// loaded separately over REST (see `applySnapshot`, driven by `onOpen`).
export class OrderbookStore {
  private books = new Map<string, Levels>();
  private ws: WebSocket | null = null;

  constructor(
    private tokenIds: string[],
    private onUpdate: (tokenId: string) => void,
    private onOpen: () => void = () => {}
  ) {}

  private levels(tokenId: string): Levels {
    let l = this.books.get(tokenId);
    if (!l) {
      l = { bids: new Map(), asks: new Map(), minOrderSize: 0, bestAsk: null, synced: false };
      this.books.set(tokenId, l);
    }
    return l;
  }

  getBestAsk(tokenId: string): number | null {
    return this.books.get(tokenId)?.bestAsk ?? null;
  }

  getBook(tokenId: string): Book | undefined {
    const l = this.books.get(tokenId);
    if (!l) return undefined;
    const toArr = (m: Map<string, number>) => [...m].map(([price, size]) => ({ price: Number(price), size }));
    return { bids: toArr(l.bids), asks: toArr(l.asks), minOrderSize: l.minOrderSize };
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  syncedCount(): number {
    let n = 0;
    for (const l of this.books.values()) if (l.synced) n++;
    return n;
  }

  applySnapshot(tokenId: string, bids: RawLevel[], asks: RawLevel[], minOrderSize?: string | number): void {
    const l = this.levels(tokenId);
    l.bids = new Map((bids ?? []).filter((x) => Number(x.size) > 0).map((x) => [key(x.price), Number(x.size)]));
    l.asks = new Map((asks ?? []).filter((x) => Number(x.size) > 0).map((x) => [key(x.price), Number(x.size)]));
    if (minOrderSize != null) l.minOrderSize = Number(minOrderSize) || 0;
    l.bestAsk = minAsk(l.asks);
    l.synced = true;
    this.onUpdate(tokenId);
  }

  connect(): void {
    this.ws = new WebSocket(WS_URL);

    this.ws.on("open", () => {
      this.ws!.send(JSON.stringify({ type: "market", assets_ids: this.tokenIds }));
      this.onOpen();
    });

    this.ws.on("message", (raw: Buffer) => {
      const text = raw.toString();
      if (text[0] !== "{" && text[0] !== "[") return; // e.g. PONG
      let events: unknown;
      try {
        events = JSON.parse(text);
      } catch {
        return;
      }
      for (const event of (Array.isArray(events) ? events : [events]) as Record<string, unknown>[]) {
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
      this.applySnapshot(
        event.asset_id as string,
        event.bids as RawLevel[],
        event.asks as RawLevel[],
        event.min_order_size as string | undefined
      );
      return;
    }

    if (event.event_type === "price_change") {
      // Current format: `price_changes`, each with its own asset_id and the
      // server-computed best_bid/best_ask after the change. Older format put
      // asset_id on the event and the list in `changes`.
      const changes = (event.price_changes ??
        ((event.changes as Record<string, unknown>[] | undefined) ?? []).map((c) => ({ ...c, asset_id: event.asset_id }))) as Record<
        string,
        unknown
      >[];
      const touched = new Set<string>();
      for (const c of changes) {
        const tokenId = String(c.asset_id);
        const l = this.levels(tokenId);
        const side = c.side === "BUY" ? l.bids : l.asks;
        const size = Number(c.size);
        if (size > 0) side.set(key(c.price as string), size);
        else side.delete(key(c.price as string));
        l.bestAsk = "best_ask" in c ? positiveOrNull(c.best_ask) : minAsk(l.asks);
        touched.add(tokenId);
      }
      for (const tokenId of touched) this.onUpdate(tokenId);
    }
  }

  close(): void {
    this.ws?.close();
  }
}

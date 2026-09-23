import type { GammaMarket } from "./types.js";
import { logger } from "./logger.js";

const GAMMA_API_URL = "https://gamma-api.polymarket.com";
const PAGE_SIZE = 100; // Gamma API caps each response at 100 regardless of a larger `limit`.

// Fetches all active binary markets from Polymarket's public Gamma API (no
// auth needed), paginating via `offset` since the API silently caps a single
// request at 100 results — passing a larger `limit` alone only returns the
// first page. The API also rejects offsets past some undocumented ceiling
// with a 422 rather than an empty page, which is treated as end-of-results
// (not an error) once at least the first page has succeeded.
export async function fetchActiveMarkets(): Promise<GammaMarket[]> {
  const all: GammaMarket[] = [];
  let offset = 0;

  while (true) {
    const url = `${GAMMA_API_URL}/markets?active=true&closed=false&limit=${PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) {
      if (offset === 0) throw new Error(`Gamma API error: ${res.status} ${res.statusText}`);
      // Expected, not an error: the API uses a non-2xx status as its
      // end-of-results signal past an undocumented offset ceiling, instead
      // of an empty page. Logged at info so it doesn't route to pm2's
      // error.log and look like something needs attention.
      logger.info(`Gamma API pagination ended at offset=${offset} (${res.status}), using what was fetched so far`);
      break;
    }
    const page = (await res.json()) as GammaMarket[];
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return all.filter((m) => m.clobTokenIds);
}

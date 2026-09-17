import type { GammaMarket } from "./types.js";

const GAMMA_API_URL = "https://gamma-api.polymarket.com";

// Fetches active binary markets from Polymarket's public Gamma API (no auth needed).
export async function fetchActiveMarkets(limit = 500): Promise<GammaMarket[]> {
  const url = `${GAMMA_API_URL}/markets?active=true&closed=false&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gamma API error: ${res.status} ${res.statusText}`);
  const markets = (await res.json()) as GammaMarket[];
  return markets.filter((m) => m.clobTokenIds);
}

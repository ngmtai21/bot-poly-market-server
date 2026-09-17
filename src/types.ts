export interface GammaMarket {
  conditionId: string;
  question: string;
  clobTokenIds: string; // JSON-encoded string array: [yesTokenId, noTokenId]
  active: boolean;
  closed: boolean;
}

export interface ArbOpportunity {
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  yesAsk: number;
  noAsk: number;
  totalCost: number; // yesAsk + noAsk
  margin: number; // 1 - totalCost
}

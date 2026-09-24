export interface GammaMarket {
  conditionId: string;
  question: string;
  clobTokenIds: string; // JSON-encoded string array: [yesTokenId, noTokenId]
  active: boolean;
  closed: boolean;
  liquidityNum?: number;
  volumeNum?: number;
  negRisk?: boolean; // picks which CTF adapter redeems this market
}

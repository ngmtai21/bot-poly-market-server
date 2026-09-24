import "dotenv/config";
import { DEFAULT_DB_PATH } from "./db.js";

export const config = {
  // Optional: a key can also be staged from the admin panel (RSA-OAEP
  // encrypted, decrypted only inside this process — see
  // walletKeyRotation.ts) instead of living in .env at all. scan.ts checks
  // that path first and falls back to this value.
  privateKey: process.env.PRIVATE_KEY ?? "",
  clobApiUrl: process.env.CLOB_API_URL ?? "https://clob.polymarket.com",
  clobApiKey: process.env.CLOB_API_KEY ?? "",
  clobApiSecret: process.env.CLOB_API_SECRET ?? "",
  clobApiPassphrase: process.env.CLOB_API_PASSPHRASE ?? "",
  minProfitMargin: Number(process.env.MIN_PROFIT_MARGIN ?? "0.01"),
  // Two-tier strategy: minProfitMargin is the "worth logging" bar (low, for
  // visibility into how often opportunities occur at all). executeMarginThreshold
  // is the higher "worth actually risking capital" bar — this bot isn't the
  // fastest in the race (see network latency findings), so a thin margin is
  // likely to be eaten by slippage/latency before the order lands. Opportunities
  // between the two are recorded but never executed, even with ENABLE_TRADING=true.
  executeMarginThreshold: Number(process.env.EXECUTE_MARGIN_THRESHOLD ?? "0.05"),
  maxOrderSizeUsdc: Number(process.env.MAX_ORDER_SIZE_USDC ?? "50"),
  // Safety gate: orders are only ever placed when this is exactly "true".
  // Defaults to dry-run so a fresh checkout never trades by accident.
  enableTrading: process.env.ENABLE_TRADING === "true",
  // Deliberately no defaults — see src/redeem.ts and README "Claiming
  // winnings" for why these must be self-verified before use.
  ctfAdapterAddress: (process.env.CTF_ADAPTER_ADDRESS ?? "") as `0x${string}`,
  negRiskCtfAdapterAddress: (process.env.NEG_RISK_CTF_ADAPTER_ADDRESS ?? "") as `0x${string}`,
  collateralTokenAddress: (process.env.COLLATERAL_TOKEN_ADDRESS ?? "") as `0x${string}`,
  dbPath: process.env.DB_PATH ?? DEFAULT_DB_PATH,
  // Runtime-only (not from .env): set by the admin panel's pause/resume.
  // Paused = keep scanning and logging, but never execute.
  paused: false,
};

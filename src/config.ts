import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export const config = {
  privateKey: required("PRIVATE_KEY"),
  clobApiUrl: process.env.CLOB_API_URL ?? "https://clob.polymarket.com",
  clobApiKey: process.env.CLOB_API_KEY ?? "",
  clobApiSecret: process.env.CLOB_API_SECRET ?? "",
  clobApiPassphrase: process.env.CLOB_API_PASSPHRASE ?? "",
  minProfitMargin: Number(process.env.MIN_PROFIT_MARGIN ?? "0.01"),
  maxOrderSizeUsdc: Number(process.env.MAX_ORDER_SIZE_USDC ?? "50"),
  // Safety gate: orders are only ever placed when this is exactly "true".
  // Defaults to dry-run so a fresh checkout never trades by accident.
  enableTrading: process.env.ENABLE_TRADING === "true",
};

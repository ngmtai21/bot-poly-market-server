import type { ClobClient } from "@polymarket/clob-client";
import { AssetType } from "@polymarket/clob-client";
import { config } from "./config.js";
import { logger } from "./logger.js";

// One-time check before entering the scan loop with trading enabled: makes
// sure the wallet actually has funded USDC.e collateral and has approved the
// CLOB exchange contract to spend it. Without this, every real order would
// fail silently (or noisily, repeatedly) once ENABLE_TRADING=true.
export async function assertTradingReady(client: ClobClient): Promise<void> {
  if (!config.enableTrading) return;

  const { balance, allowance } = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const balanceUsdc = Number(balance) / 1e6;
  const allowanceUsdc = Number(allowance) / 1e6;

  logger.info("Preflight balance/allowance check", { balanceUsdc, allowanceUsdc });

  if (balanceUsdc < config.maxOrderSizeUsdc) {
    throw new Error(
      `USDC.e balance ($${balanceUsdc}) is below MAX_ORDER_SIZE_USDC ($${config.maxOrderSizeUsdc}). Fund the proxy wallet before trading.`
    );
  }
  if (allowanceUsdc < config.maxOrderSizeUsdc) {
    throw new Error(
      `USDC.e allowance ($${allowanceUsdc}) for the CLOB exchange contract is below MAX_ORDER_SIZE_USDC ($${config.maxOrderSizeUsdc}). Approve spending via the Polymarket UI (or client.updateBalanceAllowance) before trading.`
    );
  }
}

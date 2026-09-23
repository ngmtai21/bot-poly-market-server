import { config } from "../config.js";
import { createSigner } from "../signer.js";
import { redeemPosition, checkPolBalance } from "../redeem.js";
import { logger } from "../logger.js";

// Manually redeem winning outcome tokens for a resolved market:
//   npm run redeem -- <conditionId> [--neg-risk]
// This is a manual, single-market trigger — the bot does not yet auto-detect
// resolved markets it holds positions in and redeem them automatically (that
// needs a persisted position ledger, which doesn't exist yet; see README
// backlog). Use this once you know a market you traded has resolved.
async function main() {
  const [conditionId, ...flags] = process.argv.slice(2);
  if (!conditionId) {
    console.error("Usage: npm run redeem -- <conditionId> [--neg-risk]");
    process.exit(1);
  }
  const negRisk = flags.includes("--neg-risk");

  if (!config.ctfAdapterAddress || !config.negRiskCtfAdapterAddress || !config.collateralTokenAddress) {
    console.error(
      "Missing CTF_ADAPTER_ADDRESS / NEG_RISK_CTF_ADAPTER_ADDRESS / COLLATERAL_TOKEN_ADDRESS in .env.\n" +
        "See README's 'Claiming winnings' section for how to verify these yourself before setting them."
    );
    process.exit(1);
  }

  const signer = createSigner(config.privateKey);
  const address = signer.account!.address;

  const polBalance = await checkPolBalance(address);
  logger.info("POL balance check", { address, polBalance: polBalance.toString() });
  if (polBalance === 0n) {
    console.error("Wallet has 0 POL — redeeming is an on-chain transaction and needs POL for gas.");
    process.exit(1);
  }

  const hash = await redeemPosition(signer, conditionId as `0x${string}`, negRisk, {
    ctfAdapterAddress: config.ctfAdapterAddress,
    negRiskCtfAdapterAddress: config.negRiskCtfAdapterAddress,
    collateralTokenAddress: config.collateralTokenAddress,
  });

  console.log(`Redeem transaction submitted: ${hash}`);
  console.log(`Check status: https://polygonscan.com/tx/${hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import type { WalletClient } from "viem";
import { polygon } from "viem/chains";
import { createPublicClient, http, parseAbi } from "viem";
import { logger } from "./logger.js";

// Redeems winning outcome tokens for USDC.e after a market resolves, by
// calling redeemPositions on Polymarket's CTF collateral adapter contract.
// This is a DIFFERENT system from the CLOB order API — it's a direct
// on-chain transaction against a smart contract, and costs POL (Polygon's
// gas token) to execute, separate from the USDC.e used for trading.
//
// SAFETY: the adapter/collateral contract addresses are deliberately NOT
// hardcoded here. Cross-referencing docs.polymarket.com and the public
// ConditionalTokens repo did not produce a single address I could verify
// with confidence (docs reference a newer "pUSD" wrapping flow that may
// differ from the USDC.e flow this bot otherwise uses). Sending a
// redeemPositions call to a wrong/stale contract could burn your tokens
// without paying out. You MUST supply these yourself, verified from an
// authoritative source — see README's "Claiming winnings" section for how.
const REDEEM_ABI = parseAbi([
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external",
]);

const ZERO_BYTES32 = `0x${"0".repeat(64)}` as const;

export interface RedeemConfig {
  ctfAdapterAddress: `0x${string}`;
  negRiskCtfAdapterAddress: `0x${string}`;
  collateralTokenAddress: `0x${string}`;
}

export async function redeemPosition(
  signer: WalletClient,
  conditionId: `0x${string}`,
  negRisk: boolean,
  redeemConfig: RedeemConfig
): Promise<`0x${string}`> {
  const adapterAddress = negRisk ? redeemConfig.negRiskCtfAdapterAddress : redeemConfig.ctfAdapterAddress;

  if (!signer.account) throw new Error("Signer has no account attached");

  const hash = await signer.writeContract({
    address: adapterAddress,
    abi: REDEEM_ABI,
    functionName: "redeemPositions",
    args: [redeemConfig.collateralTokenAddress, ZERO_BYTES32, conditionId, [1n, 2n]],
    account: signer.account,
    chain: polygon,
  });

  logger.info("Redeem transaction submitted", { conditionId, negRisk, hash });
  return hash;
}

// Polygon transactions (including redeemPositions) cost POL, separate from
// the USDC.e used for trading. preflight.ts only checks USDC.e — this is a
// distinct check callers should run before attempting a redeem.
export async function checkPolBalance(address: `0x${string}`): Promise<bigint> {
  const publicClient = createPublicClient({ chain: polygon, transport: http() });
  return publicClient.getBalance({ address });
}

import { createWalletClient, http, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

// Builds the wallet client used to sign CLOB orders/typed-data. clob-client
// v5+ dropped ethers in favor of viem's WalletClient as its signer type.
export function createSigner(privateKey: string): WalletClient {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  return createWalletClient({ account, chain: polygon, transport: http() });
}

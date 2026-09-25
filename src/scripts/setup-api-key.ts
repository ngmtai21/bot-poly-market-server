import { config as loadDotenv } from "dotenv";
import { ClobClient } from "@polymarket/clob-client";
import { createSigner } from "../signer.js";

loadDotenv({ path: ".env.bot", quiet: true });

// Derives and prints a Polymarket CLOB API key from your EOA private key.
// Run once, then paste the printed values into .env.bot.
async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("Missing PRIVATE_KEY in .env.bot");

  const host = process.env.CLOB_API_URL ?? "https://clob.polymarket.com";
  const signer = createSigner(privateKey);
  const client = new ClobClient(host, 137, signer);

  const creds = await client.createOrDeriveApiKey();
  console.log("Add these to your .env.bot:\n");
  console.log(`CLOB_API_KEY=${creds.key}`);
  console.log(`CLOB_API_SECRET=${creds.secret}`);
  console.log(`CLOB_API_PASSPHRASE=${creds.passphrase}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

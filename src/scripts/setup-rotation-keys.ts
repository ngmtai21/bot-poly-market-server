import { createInterface } from "node:readline/promises";
import { generateKeyPairSync } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import { DEFAULT_DB_PATH, openDb, setKv } from "../db.js";

loadDotenv({ path: ".env", quiet: true }); // DB_PATH lives in the admin env

// Run this only if you want the "stage a new wallet key from the admin
// panel" feature (POST /api/wallet/stage-key). Unrelated to admin login —
// see `npm run setup-admin` for creating admin accounts. Skip this
// entirely if you'll only ever set PRIVATE_KEY directly in the bot's
// .env.bot.
//
// Generates an RSA keypair: the PUBLIC half is stored here in SQLite (the
// admin panel uses it to encrypt a new key before staging); the PRIVATE
// half is printed once for you to copy into ../bot/.env.bot yourself. This
// process never holds the private half beyond this run — it can encrypt a
// staged key but never decrypt one.
//
// Safe to re-run: it just replaces the stored public key and prints a new
// private half. Existing staged (not-yet-applied) keys become undecryptable
// by the bot if you do this, since they were encrypted against the old key.

async function main() {
  const dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH;
  const db = openDb(dbPath);
  const interactive = process.stdin.isTTY === true;

  if (interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Generate/replace the RSA rotation keypair? (y/N): ")).trim();
    rl.close();
    if (!/^(y|yes)$/i.test(answer)) {
      console.log("Cancelled.");
      return;
    }
  }

  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 4096,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  setKv(db, "walletKeyPublicKey", publicKey);
  console.log("\nPublic key stored in the db (the admin panel uses it to encrypt a new wallet key).");
  console.log("\nAdd this to the BOT process's ../bot/.env.bot ONLY (never this repo's .env):\n");
  console.log(`WALLET_KEY_DECRYPT_PRIVATE_KEY=${Buffer.from(privateKey).toString("base64")}\n`);
  console.log("Without this, the bot ignores any key staged from the admin panel and keeps using .env.bot's PRIVATE_KEY.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

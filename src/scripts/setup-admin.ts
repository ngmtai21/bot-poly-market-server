import { createInterface } from "node:readline/promises";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { DEFAULT_DB_PATH, openDb, createUser, findUserByUsername, setKv } from "../db.js";
import { hashPassword } from "../auth.js";

// Run once (`npm run setup-admin`) to bootstrap the first admin account and
// the wallet-key-rotation keypair. Nothing here ever touches PRIVATE_KEY —
// it only writes to the shared SQLite db and prints values for you to copy
// into .env yourself. Safe to re-run: creating an admin is skipped if the
// username already exists; the rotation keypair is only (re)generated on
// request.

async function main() {
  const dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH;
  const db = openDb(dbPath);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log(`Using db: ${dbPath}\n`);

    console.log("== Admin account ==");
    const username = (await rl.question("Admin username: ")).trim();
    if (!username) throw new Error("username required");
    if (findUserByUsername(db, username)) {
      console.log(`User "${username}" already exists — skipping account creation.`);
    } else {
      const password = (await rl.question("Admin password (leave empty to auto-generate): ")).trim();
      const finalPassword = password || randomBytes(9).toString("base64url");
      createUser(db, username, hashPassword(finalPassword), "admin");
      console.log(`\nCreated admin "${username}".`);
      if (!password) console.log(`Generated password: ${finalPassword}  (save this now — it is not stored anywhere in plaintext)`);
    }

    console.log("\n== Wallet key rotation keypair ==");
    const genKeys = (await rl.question("Generate/replace the RSA rotation keypair? (y/N): ")).trim().toLowerCase();
    if (genKeys === "y" || genKeys === "yes") {
      const { publicKey, privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 4096,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      setKv(db, "walletKeyPublicKey", publicKey);
      console.log("\nPublic key stored in the db (the admin panel uses it to encrypt a new wallet key).");
      console.log("\nAdd this to the BOT process's .env ONLY (never the admin process's .env):\n");
      console.log(`WALLET_KEY_DECRYPT_PRIVATE_KEY=${Buffer.from(privateKey).toString("base64")}\n`);
      console.log("Without this, the bot ignores any key staged from the admin panel and keeps using .env PRIVATE_KEY.");
    } else {
      console.log("Skipped — wallet key rotation from the admin panel stays disabled until you run this again.");
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

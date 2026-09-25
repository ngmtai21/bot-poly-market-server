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
//
// Non-interactive mode (for deploy scripts/CI, where nothing can type into
// a readline prompt): set ADMIN_USERNAME (and optionally ADMIN_PASSWORD,
// ADMIN_GENERATE_ROTATION_KEYS=yes) as env vars and this skips every
// prompt it has an answer for. Example:
//   ADMIN_USERNAME=admin ADMIN_GENERATE_ROTATION_KEYS=yes npm run setup-admin
// A password left unset still auto-generates and prints, same as pressing
// enter interactively.
//
// Whether to prompt at all is decided by `process.stdin.isTTY`, not just
// "is the value missing" — a readline prompt against a non-TTY stream
// (piped/redirected stdin, the normal case for a deploy script) can sit
// forever on a pending question that no 'line' event will ever answer,
// and since nothing else is keeping the event loop alive, Node exits 0
// having silently done nothing. Anything required but missing outside a
// TTY must fail loudly instead of prompting into a stream that can't answer.

function truthy(v: string | undefined): boolean {
  return ["1", "y", "yes", "true"].includes((v ?? "").trim().toLowerCase());
}

async function main() {
  const dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH;
  const db = openDb(dbPath);
  const interactive = process.stdin.isTTY === true;

  const envUsername = process.env.ADMIN_USERNAME?.trim();
  const envPassword = process.env.ADMIN_PASSWORD?.trim();
  const envGenKeys = process.env.ADMIN_GENERATE_ROTATION_KEYS;

  let rl: ReturnType<typeof createInterface> | undefined;
  const ask = async (question: string): Promise<string> => {
    if (!interactive) throw new Error(`stdin is not a TTY — cannot prompt for: ${question.trim()}`);
    if (!rl) rl = createInterface({ input: process.stdin, output: process.stdout });
    return (await rl.question(question)).trim();
  };

  try {
    console.log(`Using db: ${dbPath}${interactive ? "" : " (non-interactive mode)"}\n`);

    console.log("== Admin account ==");
    const username = envUsername || (await ask("Admin username: "));
    if (!username) throw new Error("username required");
    if (findUserByUsername(db, username)) {
      console.log(`User "${username}" already exists — skipping account creation.`);
    } else {
      const password = envPassword || (interactive ? await ask("Admin password (leave empty to auto-generate): ") : "");
      const finalPassword = password || randomBytes(9).toString("base64url");
      createUser(db, username, hashPassword(finalPassword), "admin");
      console.log(`\nCreated admin "${username}".`);
      if (!password) console.log(`Generated password: ${finalPassword}  (save this now — it is not stored anywhere in plaintext)`);
    }

    console.log("\n== Wallet key rotation keypair ==");
    const genKeys = envGenKeys !== undefined || !interactive ? truthy(envGenKeys) : truthy(await ask("Generate/replace the RSA rotation keypair? (y/N): "));
    if (genKeys) {
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
    rl?.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

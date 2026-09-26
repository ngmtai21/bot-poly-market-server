import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import { DEFAULT_DB_PATH, openDb, createUser, findUserByUsername } from "../db.js";
import { hashPassword } from "../auth.js";

loadDotenv({ path: ".env", quiet: true }); // DB_PATH lives in the admin env

// Run once (`npm run setup-admin`) to bootstrap the first admin account.
// Only touches the `users` table — never PRIVATE_KEY or anything wallet-
// related. Safe to re-run: skips creating a user that already exists.
// Wallet-key rotation needs no setup here at all — the bot repo generates
// and manages its own RSA keypair, publishing the public half straight into
// the shared DB (see ../bot/src/walletKeyRotation.ts).
//
// Non-interactive mode (for deploy scripts/CI, where nothing can type into
// a readline prompt): set ADMIN_USERNAME (and optionally ADMIN_PASSWORD) as
// env vars and this skips every prompt it has an answer for. Example:
//   ADMIN_USERNAME=admin npm run setup-admin
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

async function main() {
  const dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH;
  const db = openDb(dbPath);
  const interactive = process.stdin.isTTY === true;

  const envUsername = process.env.ADMIN_USERNAME?.trim();
  const envPassword = process.env.ADMIN_PASSWORD?.trim();

  let rl: ReturnType<typeof createInterface> | undefined;
  const ask = async (question: string): Promise<string> => {
    if (!interactive) throw new Error(`stdin is not a TTY — cannot prompt for: ${question.trim()}`);
    if (!rl) rl = createInterface({ input: process.stdin, output: process.stdout });
    return (await rl.question(question)).trim();
  };

  try {
    console.log(`Using db: ${dbPath}${interactive ? "" : " (non-interactive mode)"}\n`);

    const username = envUsername || (await ask("Admin username: "));
    if (!username) throw new Error("username required");
    if (findUserByUsername(db, username)) {
      console.log(`User "${username}" already exists — skipping account creation.`);
      return;
    }
    const password = envPassword || (interactive ? await ask("Admin password (leave empty to auto-generate): ") : "");
    const finalPassword = password || randomBytes(9).toString("base64url");
    createUser(db, username, hashPassword(finalPassword), "admin");
    console.log(`\nCreated admin "${username}".`);
    if (!password) console.log(`Generated password: ${finalPassword}  (save this now — it is not stored anywhere in plaintext)`);
  } finally {
    rl?.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

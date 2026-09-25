import { privateDecrypt, constants as cryptoConstants } from "node:crypto";
import { type Db, getKv, setKv } from "./db.js";
import { logger } from "./logger.js";

// Bot-side only (imports node:crypto directly, never touched by the admin
// process). The admin panel can *stage* a new private key — RSA-OAEP
// encrypted with the public half of a keypair it only ever holds the public
// key for — but only this module, running inside the bot process with the
// matching private key (WALLET_KEY_DECRYPT_PRIVATE_KEY, in .env.bot),
// can ever recover the plaintext.

const STAGED_KEY_KV = "stagedWalletKey";
const HEX_PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

interface StagedWalletKey {
  ciphertext: string; // base64
  stagedAt: string;
}

// Consumes (and clears) a staged key at startup, if present and valid.
// Returns null when there's nothing staged, so callers fall back to
// PRIVATE_KEY from .env.bot as before.
export function consumeStagedPrivateKey(db: Db, decryptPrivateKeyB64: string | undefined): string | null {
  const staged = getKv<StagedWalletKey>(db, STAGED_KEY_KV);
  if (!staged) return null;

  if (!decryptPrivateKeyB64) {
    logger.warn(
      "A wallet key was staged from the admin panel, but WALLET_KEY_DECRYPT_PRIVATE_KEY is not set — ignoring it and using PRIVATE_KEY from .env.bot. Run `npm run setup-admin` to generate a rotation keypair."
    );
    return null;
  }

  try {
    const pem = Buffer.from(decryptPrivateKeyB64, "base64").toString("utf8");
    const plaintext = privateDecrypt(
      { key: pem, oaepHash: "sha256", padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING },
      Buffer.from(staged.ciphertext, "base64")
    ).toString("utf8");

    if (!HEX_PRIVATE_KEY.test(plaintext)) {
      throw new Error("decrypted value is not a 0x-prefixed 32-byte hex private key");
    }

    // Consume-once: clear it so a restart doesn't re-apply a stale key.
    setKv(db, STAGED_KEY_KV, null);
    logger.info(`Using wallet key staged from the admin panel at ${staged.stagedAt} (overrides .env.bot's PRIVATE_KEY)`);
    return plaintext;
  } catch (err) {
    logger.warn("Failed to decrypt staged wallet key — falling back to .env.bot's PRIVATE_KEY", err);
    return null;
  }
}

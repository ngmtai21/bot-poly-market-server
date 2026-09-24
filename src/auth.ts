import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";

// Shared by the admin process and the setup CLI. Never imports config.ts,
// signer.ts, or anything touching PRIVATE_KEY — safe under the admin/
// ESLint import boundary.

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, SCRYPT_KEYLEN);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export type Role = "admin" | "guest";

export interface SessionPayload {
  userId: number;
  username: string;
  role: Role;
  exp: number; // epoch ms
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

// A stateless, HMAC-signed bearer token — no session table needed. Its
// secret only lets you *mint tokens*, not read stored credentials; the
// actual password hashes stay in the users table regardless of who holds it.
export function createSessionToken(payload: Omit<SessionPayload, "exp">, secret: string): string {
  const body: SessionPayload = { ...payload, exp: Date.now() + SESSION_TTL_MS };
  const data = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${data}.${sign(data, secret)}`;
}

export function verifySessionToken(token: string, secret: string): SessionPayload | null {
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expectedSig = sign(data, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

import crypto from "node:crypto";

const TOKEN_TTL_MS = 1000 * 60 * 60 * 12;

export function uid(prefix: string) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

export function hashPassword(password: string, salt = crypto.randomBytes(16).toString("hex")) {
  const key = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${key}`;
}

export function verifyPassword(password: string, stored: string) {
  const [, salt, key] = stored.split(":");
  if (!salt || !key) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(key, "hex"), candidate);
}

function base64Url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url");
}

export function signToken(payload: Record<string, unknown>, secret: string) {
  const body = {
    ...payload,
    exp: Date.now() + TOKEN_TTL_MS
  };
  const encoded = base64Url(JSON.stringify(body));
  const sig = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

export function verifyToken(token: string, secret: string) {
  const [encoded, sig] = token.split(".");
  if (!encoded || !sig) return null;
  const expected = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
  return payload as { sub: string; role: string; scope?: string; exp: number };
}

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createPlainToken() {
  return `bot_${crypto.randomBytes(32).toString("base64url")}`;
}

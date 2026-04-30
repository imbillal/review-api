import crypto from "node:crypto";

function secret(): string {
  const s = process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error("NEXTAUTH_SECRET not set");
  return s;
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function fromB64url(s: string): Buffer {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export type AuthPayload = { sub: string; email: string; iat: number; exp: number };

export function signAuthToken(
  payload: { sub: string; email: string },
  ttlSec = 60 * 60 * 24 * 30,
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body: AuthPayload = { sub: payload.sub, email: payload.email, iat: now, exp: now + ttlSec };
  const headerEnc = b64url(Buffer.from(JSON.stringify(header)));
  const bodyEnc = b64url(Buffer.from(JSON.stringify(body)));
  const signingInput = `${headerEnc}.${bodyEnc}`;
  const sig = b64url(crypto.createHmac("sha256", secret()).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

export function verifyAuthToken(token: string): AuthPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, b, s] = parts as [string, string, string];
  const signingInput = `${h}.${b}`;
  const expected = b64url(
    crypto.createHmac("sha256", secret()).update(signingInput).digest(),
  );
  const aBuf = Buffer.from(s);
  const eBuf = Buffer.from(expected);
  if (aBuf.length !== eBuf.length || !crypto.timingSafeEqual(aBuf, eBuf)) return null;
  try {
    const payload = JSON.parse(fromB64url(b).toString("utf8")) as AuthPayload;
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

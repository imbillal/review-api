import crypto from "node:crypto";

/**
 * Short-lived HMAC tokens used to authorize iframe loads of the website bundle.
 * Cross-origin iframe can't forward cookies in dev (localhost:3100 → localhost:3001),
 * so we hand the iframe a signed token in the URL.
 *
 * Token format: userId.docId.expiresAtMs.hmacHex
 */
function secret() {
  const s = process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error("NEXTAUTH_SECRET not set");
  return s;
}

export function signBundleToken(userId: string, docId: string, ttlMs = 10 * 60 * 1000): string {
  const exp = Date.now() + ttlMs;
  const payload = `${userId}.${docId}.${exp}`;
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export function verifyBundleToken(
  token: string,
  docId: string,
): { userId: string } | null {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [userId, tokenDocId, expStr, sig] = parts;
  if (!userId || tokenDocId !== docId || !expStr || !sig) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const payload = `${userId}.${tokenDocId}.${expStr}`;
  const expected = crypto.createHmac("sha256", secret()).update(payload).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) {
    return null;
  }
  return { userId };
}

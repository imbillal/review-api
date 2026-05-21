import { randomInt } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Opaque DNS-safe label, e.g. "d-ab12cd34". Collision-free in practice. */
export function generateSubdomain(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `d-${s}`;
}

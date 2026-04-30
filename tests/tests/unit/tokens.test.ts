import { describe, expect, it } from "vitest";
import { generateToken, hashToken } from "@/lib/tokens";

describe("generateToken", () => {
  it("produces a 64-char hex string", () => {
    const t = generateToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });
  it("produces unique values", () => {
    const set = new Set(Array.from({ length: 20 }, () => generateToken()));
    expect(set.size).toBe(20);
  });
});

describe("hashToken", () => {
  it("is deterministic", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
  });
  it("differs per input", () => {
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
  });
});

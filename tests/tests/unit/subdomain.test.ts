import { describe, expect, it } from "vitest";
import { generateSubdomain } from "@/lib/subdomain";

describe("generateSubdomain", () => {
  it("matches d- followed by 8 lowercase alphanumerics", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateSubdomain()).toMatch(/^d-[a-z0-9]{8}$/);
    }
  });

  it("is overwhelmingly likely to be unique across many calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateSubdomain());
    expect(seen.size).toBe(1000);
  });
});

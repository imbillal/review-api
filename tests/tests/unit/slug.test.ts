import { describe, expect, it } from "vitest";
import { slugify, ensureUniqueSlug } from "@/lib/slug";

describe("slugify", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Acme Redesign")).toBe("acme-redesign");
  });
  it("strips non-alphanumerics", () => {
    expect(slugify("hello, world!")).toBe("hello-world");
  });
  it("collapses consecutive separators", () => {
    expect(slugify("foo   bar___baz")).toBe("foo-bar-baz");
  });
  it("trims leading/trailing hyphens", () => {
    expect(slugify("-hello-")).toBe("hello");
  });
  it("returns 'untitled' on empty", () => {
    expect(slugify("!!!")).toBe("untitled");
  });
});

describe("ensureUniqueSlug", () => {
  it("returns base when not taken", async () => {
    const check = async (_: string) => false;
    expect(await ensureUniqueSlug("acme", check)).toBe("acme");
  });
  it("appends -2, -3 when taken", async () => {
    const taken = new Set(["acme", "acme-2"]);
    const check = async (s: string) => taken.has(s);
    expect(await ensureUniqueSlug("acme", check)).toBe("acme-3");
  });
});

import { describe, expect, it } from "vitest";
import {
  generateSubdomain,
  deriveSubdomainBase,
  suffixSubdomain,
  createWithUniqueSubdomain,
} from "@/lib/subdomain";

// The proxy accepts any single DNS label matching ^[a-z0-9][a-z0-9-]*$.
const LABEL = /^[a-z0-9][a-z0-9-]*$/;

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

describe("deriveSubdomainBase", () => {
  it("flattens the host: dots become hyphens", () => {
    expect(deriveSubdomainBase("https://billal.dev")).toBe("billal-dev");
    expect(deriveSubdomainBase("https://dorik.com/some/path")).toBe("dorik-com");
  });

  it("strips a leading www. but keeps other subdomains", () => {
    expect(deriveSubdomainBase("https://www.dorik.com")).toBe("dorik-com");
    expect(deriveSubdomainBase("https://app.billal.dev")).toBe("app-billal-dev");
  });

  it("lowercases and ignores port / path / query", () => {
    expect(deriveSubdomainBase("https://Billal.DEV:8443/x?y=1")).toBe("billal-dev");
  });

  it("collapses runs of non-alphanumerics and trims edges", () => {
    expect(deriveSubdomainBase("https://my--site..co.uk")).toBe("my-site-co-uk");
  });

  it("truncates to a DNS-safe length with no trailing hyphen", () => {
    const long = "a".repeat(80) + ".com";
    const out = deriveSubdomainBase(`https://${long}`);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith("-")).toBe(false);
  });

  it("falls back to a random d-xxxx when the host yields nothing usable", () => {
    expect(deriveSubdomainBase("not a url")).toMatch(/^d-[a-z0-9]{8}$/);
  });

  it("always produces a valid single DNS label", () => {
    for (const u of [
      "https://billal.dev",
      "https://www.dorik.com",
      "https://app.example.co.uk",
      "https://_weird_.example.com",
    ]) {
      expect(deriveSubdomainBase(u)).toMatch(LABEL);
    }
  });
});

describe("suffixSubdomain", () => {
  it("appends a 4-char random suffix to the base", () => {
    expect(suffixSubdomain("billal-dev")).toMatch(/^billal-dev-[a-z0-9]{4}$/);
  });
});

describe("createWithUniqueSubdomain", () => {
  const isTaken = (e: unknown) => e instanceof Error && e.message === "taken";

  it("uses the clean base when it's free", async () => {
    const stored = await createWithUniqueSubdomain("billal-dev", async () => {}, isTaken);
    expect(stored).toBe("billal-dev");
  });

  it("retries with a suffixed name when the base collides", async () => {
    const used: string[] = [];
    const stored = await createWithUniqueSubdomain(
      "billal-dev",
      async (subdomain) => {
        used.push(subdomain);
        if (subdomain === "billal-dev") throw new Error("taken");
      },
      isTaken,
    );
    expect(used[0]).toBe("billal-dev");
    expect(stored).toMatch(/^billal-dev-[a-z0-9]{4}$/);
  });

  it("falls back to a random d-xxxx after repeated collisions", async () => {
    const stored = await createWithUniqueSubdomain(
      "billal-dev",
      async (subdomain) => {
        if (!subdomain.startsWith("d-")) throw new Error("taken");
      },
      isTaken,
    );
    expect(stored).toMatch(/^d-[a-z0-9]{8}$/);
  });

  it("re-throws errors that are not unique-violations", async () => {
    await expect(
      createWithUniqueSubdomain(
        "billal-dev",
        async () => {
          throw new Error("db down");
        },
        isTaken,
      ),
    ).rejects.toThrow("db down");
  });
});

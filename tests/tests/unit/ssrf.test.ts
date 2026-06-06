import { describe, expect, it } from "vitest";
import { validateProxyTarget, resolveCanonicalTarget } from "@/lib/ssrf";

// Build a fake fetch from a map of requested-URL -> { status, location }.
function fakeFetch(routes: Record<string, { status: number; location?: string }>) {
  return (async (input: string) => {
    const r = routes[input] ?? routes[input.replace(/\/$/, "")] ?? { status: 200 };
    return {
      status: r.status,
      headers: { get: (k: string) => (k.toLowerCase() === "location" ? (r.location ?? null) : null) },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("validateProxyTarget", () => {
  it("accepts a normal https site and returns its origin", () => {
    const r = validateProxyTarget("https://dorik.com/about?x=1");
    expect(r).toEqual({ ok: true, origin: "https://dorik.com" });
  });

  it("accepts http and keeps a non-default port in the origin", () => {
    const r = validateProxyTarget("http://example.com:8080/x");
    expect(r).toEqual({ ok: true, origin: "http://example.com:8080" });
  });

  it.each([
    ["not a url", "ftp://example.com"],
    ["loopback name", "http://localhost/"],
    ["loopback v4", "http://127.0.0.1/"],
    ["0.0.0.0", "http://0.0.0.0/"],
    ["private 10/8", "http://10.1.2.3/"],
    ["private 192.168", "http://192.168.0.1/"],
    ["private 172.16", "http://172.16.5.5/"],
    ["private 172.31", "http://172.31.255.255/"],
    ["link-local / metadata", "http://169.254.169.254/"],
    ["ipv6 loopback", "http://[::1]/"],
    ["ipv6 ULA", "http://[fc00::1]/"],
    ["ipv6 link-local", "http://[fe80::1]/"],
    ["mdns suffix", "http://printer.local/"],
    ["garbage", "::::"],
  ])("rejects %s", (_name, url) => {
    expect(validateProxyTarget(url).ok).toBe(false);
  });

  it("accepts 172.32 (outside the private /12)", () => {
    expect(validateProxyTarget("http://172.32.0.1/").ok).toBe(true);
  });
});

describe("resolveCanonicalTarget", () => {
  it("returns the input origin when the site does not redirect", async () => {
    const r = await resolveCanonicalTarget("https://www.tradogram.com/x", {
      fetchImpl: fakeFetch({ "https://www.tradogram.com/": { status: 200 } }),
    });
    expect(r).toEqual({ ok: true, origin: "https://www.tradogram.com" });
  });

  it("follows an apex → www redirect and stores the canonical origin", async () => {
    const r = await resolveCanonicalTarget("https://tradogram.com", {
      fetchImpl: fakeFetch({
        "https://tradogram.com/": { status: 301, location: "https://www.tradogram.com/" },
        "https://www.tradogram.com/": { status: 200 },
      }),
    });
    expect(r).toEqual({ ok: true, origin: "https://www.tradogram.com" });
  });

  it("treats a same-origin redirect (/ → /en) as already canonical", async () => {
    const r = await resolveCanonicalTarget("https://rust-lang.org", {
      fetchImpl: fakeFetch({
        "https://rust-lang.org/": { status: 302, location: "/en-US/" },
      }),
    });
    expect(r).toEqual({ ok: true, origin: "https://rust-lang.org" });
  });

  it("refuses to follow a redirect into private space, keeping the last safe origin", async () => {
    const r = await resolveCanonicalTarget("https://evil.example", {
      fetchImpl: fakeFetch({
        "https://evil.example/": { status: 302, location: "http://169.254.169.254/latest/meta-data" },
      }),
    });
    expect(r).toEqual({ ok: true, origin: "https://evil.example" });
  });

  it("falls back to the input origin on a network error", async () => {
    const throwing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await resolveCanonicalTarget("https://flaky.example", { fetchImpl: throwing });
    expect(r).toEqual({ ok: true, origin: "https://flaky.example" });
  });

  it("stops after maxHops and returns the last origin", async () => {
    // Each host redirects to the next — never settles.
    const fetchImpl = (async (input: string) => {
      const n = Number(input.match(/h(\d+)\./)?.[1] ?? "0");
      return {
        status: 301,
        headers: { get: (k: string) => (k.toLowerCase() === "location" ? `https://h${n + 1}.example/` : null) },
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const r = await resolveCanonicalTarget("https://h0.example", { maxHops: 3, fetchImpl });
    expect(r.ok).toBe(true);
    expect((r as { origin: string }).origin).toMatch(/^https:\/\/h\d+\.example$/);
  });

  it("propagates an invalid input url", async () => {
    const r = await resolveCanonicalTarget("not a url");
    expect(r.ok).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { validateProxyTarget } from "@/lib/ssrf";

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

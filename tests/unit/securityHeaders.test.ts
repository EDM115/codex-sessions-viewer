import { describe, expect, it } from "vitest";

import {
  browserSecurityHeaders,
  contentSecurityPolicy,
  staticBrowserSecurityHeaders,
} from "#server/core/securityHeaders.ts";

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(";").map((part) => {
      const [name, ...values] = part.trim().split(/\s+/u);
      if (name === undefined) {
        throw new Error("The CSP contains an empty directive.");
      }
      return [name, values];
    }),
  );
}

describe("browser security headers", () => {
  it("contains the loopback viewer without allowing remote or evaluated code", () => {
    const parsed = directives(contentSecurityPolicy);

    expect(parsed.get("default-src")).toEqual(["'self'"]);
    expect(parsed.get("base-uri")).toEqual(["'none'"]);
    expect(parsed.get("object-src")).toEqual(["'none'"]);
    expect(parsed.get("frame-ancestors")).toEqual(["'none'"]);
    expect(parsed.get("form-action")).toEqual(["'none'"]);
    expect(parsed.get("connect-src")).toEqual(["'self'"]);
    expect(parsed.get("script-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(parsed.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(parsed.get("img-src")).toEqual(["'self'", "data:", "blob:"]);
    expect(parsed.get("media-src")).toEqual(["'self'", "data:", "blob:"]);
    expect(parsed.get("font-src")).toEqual(["'self'", "data:"]);
    expect(parsed.get("worker-src")).toEqual(["'self'"]);
    expect(contentSecurityPolicy).not.toMatch(/unsafe-eval|https?:|\*/u);
  });

  it("exports an immutable header record for live responses", () => {
    expect(Object.isFrozen(browserSecurityHeaders)).toBe(true);
    expect(browserSecurityHeaders).toEqual({
      "Content-Security-Policy": contentSecurityPolicy,
      "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    });
  });

  it("permits only WebAssembly compilation in the static policy and retains every other boundary", () => {
    const policy = staticBrowserSecurityHeaders["Content-Security-Policy"]!;
    const parsed = directives(policy);
    expect(Object.isFrozen(staticBrowserSecurityHeaders)).toBe(true);
    expect(parsed.get("script-src")).toEqual(["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"]);
    expect(parsed.get("script-src")).not.toContain("'unsafe-eval'");
    expect(policy).not.toMatch(/https?:|\*/u);
    expect(Object.fromEntries([...parsed].filter(([name]) => name !== "script-src"))).toEqual(
      Object.fromEntries(
        [...directives(contentSecurityPolicy)].filter(([name]) => name !== "script-src"),
      ),
    );
    expect(
      Object.entries(staticBrowserSecurityHeaders).filter(
        ([name]) => name !== "Content-Security-Policy",
      ),
    ).toEqual(
      Object.entries(browserSecurityHeaders).filter(([name]) => name !== "Content-Security-Policy"),
    );
  });
});

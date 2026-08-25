const directives = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "connect-src 'self'",
  // Static Nuxt output contains an inline import map and runtime-config bootstrap. Their content
  // changes per build, so stable hashes or nonces would require rewriting every generated page.
  "script-src 'self' 'unsafe-inline'",
  // Virtualized rows, minimap markers, and media transforms use Vue-managed style attributes.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self'",
];

export const contentSecurityPolicy = directives.join("; ");

export const browserSecurityHeaders: Readonly<Record<string, string>> = Object.freeze({
  "Content-Security-Policy": contentSecurityPolicy,
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
});

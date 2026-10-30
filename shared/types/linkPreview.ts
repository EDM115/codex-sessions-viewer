import * as z from "zod";

export function canonicalWebsiteUrl(input: string): string {
  if (input.length > 4096) {
    throw new Error("preview.invalid_url");
  }
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !url.hostname.includes(".") ||
    /^[\d.]+$/u.test(url.hostname) ||
    url.hostname.startsWith("[") ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|onion|lan|home)$/iu.test(url.hostname)
  ) {
    throw new Error("preview.invalid_url");
  }
  url.hash = "";
  return url.href;
}
export const linkPreviewSchema = z.strictObject({
  version: z.literal(1),
  provenance: z.literal("viewer-enrichment"),
  url: z.string(),
  finalUrl: z.string().nullable(),
  revision: z.string(),
  availability: z.enum(["ready", "unavailable", "disabled", "overloaded"]),
  title: z.string().max(300).nullable(),
  description: z.string().max(1000).nullable(),
  fetchedAt: z.string().nullable(),
  retryAt: z.string().nullable(),
  reason: z.enum(["disabled", "unavailable", "unsupported", "timeout", "overloaded"]).nullable(),
  image: z
    .strictObject({
      url: z
        .string()
        .regex(/^\/(?:api\/link-preview-images|previews)\/[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/u),
      sourceUrl: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
      byteSize: z
        .int()
        .positive()
        .max(2 * 1024 * 1024),
      width: z.int().positive().max(8192),
      height: z.int().positive().max(8192),
    })
    .nullable(),
});
export type LinkPreview = z.infer<typeof linkPreviewSchema>;
export type LinkPreviewResolver = (
  url: string,
  options?: { signal?: AbortSignal },
) => Promise<LinkPreview>;

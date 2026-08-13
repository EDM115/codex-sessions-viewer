import { createHash } from "node:crypto";

import type { Element, Properties, Root as HastRoot, RootContent as HastRootContent } from "hast";
import type { Root as MdastRoot, RootContent as MdastRootContent } from "mdast";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import {
  richTextDocumentSchema,
  type EmbeddedMediaSource,
  type RichTextAlertNode,
  type RichTextAttribute,
  type RichTextElementTag,
  type RichTextDocument,
  type RichTextMediaNode,
  type RichTextNode,
} from "../../shared/types/richText.ts";
import { highlightCode } from "./highlightCode.ts";
import { richTextSanitizeSchema } from "./sanitizeSchema.ts";

const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
const MAX_EMBEDDED_MEDIA_BYTES = 5 * 1024 * 1024;
const elementTags: ReadonlySet<string> = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "strong",
  "em",
  "del",
  "code",
  "hr",
  "br",
  "sup",
  "sub",
  "section",
  "details",
  "summary",
  "input",
  "kbd",
]);
const alertPattern = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/u;

export interface ParseRichTextOptions {
  baseUrl?: string | undefined;
  assetIdsByPath?: ReadonlyMap<string, string> | undefined;
}

export interface ParsedRichText {
  document: RichTextDocument;
  embeddedMedia: EmbeddedMediaSource[];
}

interface ConversionContext {
  options: ParseRichTextOptions;
  embeddedMedia: Map<string, EmbeddedMediaSource>;
}

function annotateMarkdown() {
  return (tree: MdastRoot): void => {
    const visit = (node: MdastRoot | MdastRootContent): void => {
      if (node.type === "code") {
        node.data = node.data ?? {};
        node.data.hProperties = {
          ...node.data.hProperties,
          dataLanguage: node.lang ?? "",
          dataMeta: node.meta ?? "",
        };
      } else if (node.type === "image" && node.url !== undefined) {
        node.data = node.data ?? {};
        node.data.hProperties = {
          ...node.data.hProperties,
          dataOriginalSrc: node.url,
        };
      }
      if ("children" in node) {
        for (const child of node.children) {
          visit(child);
        }
      }
    };
    visit(tree);
  };
}

function property(properties: Properties | undefined, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = properties?.[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

function textContent(node: HastRoot | HastRootContent): string {
  return node.type === "text"
    ? node.value
    : "children" in node
      ? node.children.map(textContent).join("")
      : "";
}

function codeTitle(meta: string | null): string | null {
  if (meta === null) {
    return null;
  }
  const match = /(?:^|\s)(?:title|filename)=(?:"([^"]*)"|'([^']*)'|(\S+))/iu.exec(meta);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function safeAttributes(properties: Properties | undefined): Record<string, RichTextAttribute> {
  const attributes: Record<string, RichTextAttribute> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (
      /^on/iu.test(key) ||
      key === "style" ||
      key === "href" ||
      key === "src" ||
      key.startsWith("data")
    ) {
      continue;
    }
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      attributes[key] = value;
    } else if (Array.isArray(value)) {
      attributes[key] = value.filter((item): item is string => typeof item === "string");
    }
  }
  return attributes;
}

function canonicalLink(
  href: string,
  baseUrl: string | undefined,
): { url: string; origin: string | null } | null {
  try {
    const url = baseUrl === undefined ? new URL(href) : new URL(href, baseUrl);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return { url: url.href, origin: url.origin };
    }
    return url.protocol === "mailto:" ? { url: url.href, origin: null } : null;
  } catch {
    return /^[#./]/u.test(href) ? { url: href, origin: null } : null;
  }
}

function filePath(source: string): string {
  if (!source.toLowerCase().startsWith("file://")) {
    return source;
  }
  try {
    let path = decodeURIComponent(new URL(source).pathname);
    if (/^\/[a-z]:\//iu.test(path)) {
      path = path.slice(1);
    }
    return process.platform === "win32" ? path.replaceAll("/", "\\") : path;
  } catch {
    return source;
  }
}

function embeddedImage(source: string): EmbeddedMediaSource | null {
  const match = /^data:(image\/(?:png|jpeg|gif|webp|avif|svg\+xml));base64,([a-z\d+/=\s]+)$/iu.exec(
    source,
  );
  if (match === null) {
    return null;
  }
  const bytes = Buffer.from(match[2]!.replaceAll(/\s/gu, ""), "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_EMBEDDED_MEDIA_BYTES) {
    return null;
  }
  const assetId = `asset-${createHash("sha256").update(bytes).digest("hex")}`;
  return {
    assetId,
    mediaType: "image",
    mimeType: match[1]!.toLowerCase(),
    byteSize: bytes.byteLength,
    bytes,
  };
}

function mediaNode(node: Element, context: ConversionContext): RichTextMediaNode {
  const rawSource = property(node.properties, "dataOriginalSrc", "data-original-src", "src") ?? "";
  const alt = property(node.properties, "alt") ?? "";
  const title = property(node.properties, "title");
  const embedded = embeddedImage(rawSource);
  if (embedded !== null) {
    context.embeddedMedia.set(embedded.assetId, embedded);
    return {
      type: "media",
      mediaType: "image",
      source: "asset",
      assetId: embedded.assetId,
      originalSource: rawSource,
      alt,
      title,
    };
  }
  if (/^https?:\/\//iu.test(rawSource)) {
    return {
      type: "media",
      mediaType: "image",
      source: "external",
      assetId: null,
      originalSource: rawSource,
      alt,
      title,
    };
  }
  const localPath = filePath(rawSource);
  const assetId = context.options.assetIdsByPath?.get(localPath) ?? null;
  return {
    type: "media",
    mediaType: "image",
    source: assetId === null ? "missing" : "asset",
    assetId,
    originalSource: localPath,
    alt,
    title,
  };
}

function alert(children: RichTextNode[]): RichTextAlertNode | null {
  const first = children.find((child) => child.type !== "text" || child.text.trim() !== "");
  if (first?.type !== "element" || first.tagName !== "p") {
    return null;
  }
  const text = first.children[0];
  if (text?.type !== "text") {
    return null;
  }
  const match = alertPattern.exec(text.text);
  if (match === null) {
    return null;
  }
  const kind = alertKind(match[1]!.toLowerCase());
  if (kind === null) {
    return null;
  }
  text.text = text.text.slice(match[0].length);
  return { type: "alert", kind, children };
}

function alertKind(value: string): RichTextAlertNode["kind"] | null {
  switch (value) {
    case "caution":
    case "important":
    case "note":
    case "tip":
    case "warning":
      return value;
    default:
      return null;
  }
}

async function convertChildren(
  node: HastRoot | Element,
  context: ConversionContext,
): Promise<RichTextNode[]> {
  return (await Promise.all(node.children.map((child) => convertNode(child, context)))).flat();
}

function isRichTextElementTag(value: string): value is RichTextElementTag {
  return elementTags.has(value);
}

async function convertNode(
  node: HastRootContent,
  context: ConversionContext,
): Promise<RichTextNode[]> {
  if (node.type === "text") {
    return [{ type: "text", text: node.value ?? "" }];
  }
  if (node.type !== "element") {
    return [];
  }
  if (node.tagName === "pre") {
    const code =
      node.children.find(
        (child): child is Element => child.type === "element" && child.tagName === "code",
      ) ?? node;
    const language = property(code.properties, "dataLanguage", "data-language") || null;
    const source = textContent(code).replace(/\n$/u, "");
    if (language?.toLowerCase() === "mermaid") {
      return [{ type: "mermaid", source }];
    }
    return [
      {
        type: "code",
        language,
        title: codeTitle(property(code.properties, "dataMeta", "data-meta")),
        source,
        highlighted: await highlightCode(source, language),
      },
    ];
  }
  if (node.tagName === "a") {
    const children = await convertChildren(node, context);
    const href = property(node.properties, "href");
    const link = href === null ? null : canonicalLink(href, context.options.baseUrl);
    return link === null
      ? children
      : [{ type: "link", ...link, title: property(node.properties, "title"), children }];
  }
  if (node.tagName === "img") {
    return [mediaNode(node, context)];
  }
  const children = await convertChildren(node, context);
  if (node.tagName === "blockquote") {
    const convertedAlert = alert(children);
    if (convertedAlert !== null) {
      return [convertedAlert];
    }
  }
  if (!isRichTextElementTag(node.tagName)) {
    return children;
  }
  return [
    {
      type: "element",
      tagName: node.tagName,
      attributes: safeAttributes(node.properties),
      children,
    },
  ];
}

export async function parseRichText(
  markdown: string,
  options: ParseRichTextOptions = {},
): Promise<ParsedRichText> {
  if (Buffer.byteLength(markdown, "utf8") > MAX_MARKDOWN_BYTES) {
    throw new RangeError("Markdown input exceeds the viewer's 5 MiB limit.");
  }
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(annotateMarkdown)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, richTextSanitizeSchema);
  const tree: HastRoot = await processor.run(processor.parse(markdown));
  const context: ConversionContext = { options, embeddedMedia: new Map() };
  return {
    document: richTextDocumentSchema.parse({
      type: "document",
      children: await convertChildren(tree, context),
    }),
    embeddedMedia: [...context.embeddedMedia.values()],
  };
}

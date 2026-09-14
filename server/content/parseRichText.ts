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

function annotateMarkdown(markdown: string) {
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
      } else if (node.type === "link" && node.url !== undefined) {
        const source = markdown.slice(node.position?.start.offset, node.position?.end.offset);
        const destination = source
          .slice(source.lastIndexOf("](") + 2)
          .match(/^(?:<([^>]+)>|([^\s)]+))/u);
        const literal = destination?.[1] ?? destination?.[2];
        // CommonMark unescapes the leading pair of UNC backslashes. Restore that
        // prefix only; the parsed destination handles balanced parentheses/titles.
        const href =
          literal?.startsWith("\\\\") && node.url.startsWith("\\") && !node.url.startsWith("\\\\")
            ? `\\${node.url}`
            : node.url;
        node.data = node.data ?? {};
        node.data.hProperties = {
          ...node.data.hProperties,
          dataOriginalHref: href,
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
  // A drive letter is a filesystem prefix, even though URL parses it as a scheme.
  if (/^(?:[a-z]:[\\/]|\\\\)/iu.test(href) || href.startsWith("#")) {
    return { url: href, origin: null };
  }
  try {
    const url = baseUrl === undefined ? new URL(href) : new URL(href, baseUrl);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return { url: url.href, origin: url.origin };
    }
    return url.protocol === "mailto:" || url.protocol === "file:"
      ? { url: url.href, origin: null }
      : null;
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
    const annotatedLanguage = property(code.properties, "dataLanguage", "data-language");
    const classes: unknown = code.properties.className;
    const languageClass = (
      Array.isArray(classes) ? classes : typeof classes === "string" ? classes.split(/\s+/u) : []
    ).find((value) => typeof value === "string" && /^language-[\w+-]+$/u.test(value));
    const language =
      annotatedLanguage !== null
        ? annotatedLanguage || null
        : typeof languageClass === "string"
          ? languageClass.slice("language-".length)
          : null;
    const source =
      annotatedLanguage !== null ? textContent(code).replace(/\n$/u, "") : textContent(code);
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
    const href = property(node.properties, "dataOriginalHref", "data-original-href", "href");
    const link = href === null ? null : canonicalLink(href, context.options.baseUrl);
    return link === null
      ? children
      : [
          {
            type: "link",
            ...link,
            title: property(node.properties, "title"),
            attributes: safeAttributes(node.properties),
            children,
          },
        ];
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
    .use(annotateMarkdown, markdown)
    .use(remarkRehype, { allowDangerousHtml: true, clobberPrefix: "" })
    .use(rehypeRaw)
    .use(rehypeSanitize, richTextSanitizeSchema);
  const tree: HastRoot = await processor.run(processor.parse(markdown));
  normalizeAnchorReferences(tree);
  const context: ConversionContext = { options, embeddedMedia: new Map() };
  return {
    document: richTextDocumentSchema.parse({
      type: "document",
      children: await convertChildren(tree, context),
    }),
    embeddedMedia: [...context.embeddedMedia.values()],
  };
}

// Sanitization prefixes IDs. Rewrite references with the same mapping, including
// generated footnote references/backlinks, before the renderer scopes each document.
function normalizeAnchorReferences(tree: HastRoot): void {
  const elements: Element[] = [];
  function visit(node: HastRoot | HastRootContent): void {
    if (node.type === "element") {
      elements.push(node);
    }
    if ("children" in node) {
      node.children.forEach(visit);
    }
  }
  visit(tree);
  const ids = new Map<string, string>();
  for (const element of elements) {
    const id = property(element.properties, "id");
    if (id !== null) {
      ids.set(id, id);
      ids.set(id.replace(/^user-content-/u, ""), id);
    }
  }
  for (const element of elements) {
    for (const key of ["href", "dataOriginalHref"]) {
      const value = property(element.properties, key);
      if (value?.startsWith("#") && ids.has(value.slice(1))) {
        element.properties[key] = `#${ids.get(value.slice(1))!}`;
      }
    }
    for (const key of ["ariaDescribedBy", "ariaLabelledBy"]) {
      const value = element.properties[key];
      if (Array.isArray(value)) {
        element.properties[key] = value.map((id) =>
          typeof id === "string" ? (ids.get(id) ?? id) : id,
        );
      } else if (typeof value === "string") {
        element.properties[key] = value
          .split(/\s+/u)
          .map((id) => ids.get(id) ?? id)
          .join(" ");
      }
    }
  }
}

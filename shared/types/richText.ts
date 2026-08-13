import * as z from "zod";

export type RichTextElementTag =
  | "p"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "blockquote"
  | "ul"
  | "ol"
  | "li"
  | "table"
  | "thead"
  | "tbody"
  | "tr"
  | "th"
  | "td"
  | "strong"
  | "em"
  | "del"
  | "code"
  | "hr"
  | "br"
  | "sup"
  | "sub"
  | "section"
  | "details"
  | "summary"
  | "input"
  | "kbd";

export type RichTextAttribute = boolean | number | string | string[];

export interface RichTextTextNode {
  type: "text";
  text: string;
}

export interface RichTextElementNode {
  type: "element";
  tagName: RichTextElementTag;
  attributes: Record<string, RichTextAttribute>;
  children: RichTextNode[];
}

export interface RichTextLinkNode {
  type: "link";
  url: string;
  origin: string | null;
  title: string | null;
  children: RichTextNode[];
}

export interface HighlightedCodeTextNode {
  type: "text";
  text: string;
}

export interface HighlightedCodeElementNode {
  type: "element";
  tagName: "pre" | "code" | "span";
  attributes: Record<string, RichTextAttribute>;
  children: HighlightedCodeNode[];
}

export interface HighlightedCodeRoot {
  type: "root";
  children: HighlightedCodeNode[];
}

export type HighlightedCodeNode = HighlightedCodeTextNode | HighlightedCodeElementNode;

export interface RichTextCodeNode {
  type: "code";
  language: string | null;
  title: string | null;
  source: string;
  highlighted: HighlightedCodeRoot | null;
}

export interface RichTextMermaidNode {
  type: "mermaid";
  source: string;
}

export interface RichTextMediaNode {
  type: "media";
  mediaType: "image" | "audio" | "video" | "file";
  source: "asset" | "external" | "missing";
  assetId: string | null;
  originalSource: string;
  alt: string;
  title: string | null;
}

export interface RichTextAlertNode {
  type: "alert";
  kind: "note" | "tip" | "important" | "warning" | "caution";
  children: RichTextNode[];
}

export type RichTextNode =
  | RichTextTextNode
  | RichTextElementNode
  | RichTextLinkNode
  | RichTextCodeNode
  | RichTextMermaidNode
  | RichTextMediaNode
  | RichTextAlertNode;

export interface RichTextDocument {
  type: "document";
  children: RichTextNode[];
}

export interface EmbeddedMediaSource {
  assetId: string;
  mediaType: "image";
  mimeType: string;
  byteSize: number;
  bytes: Uint8Array;
}

const richTextAttributeSchema = z.union([z.boolean(), z.number(), z.string(), z.array(z.string())]);
const richTextElementTagSchema = z.enum([
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

export const highlightedCodeNodeSchema: z.ZodType<HighlightedCodeNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("text"), text: z.string() }),
    z.strictObject({
      type: z.literal("element"),
      tagName: z.enum(["pre", "code", "span"]),
      attributes: z.record(z.string(), richTextAttributeSchema),
      children: z.array(highlightedCodeNodeSchema),
    }),
  ]),
);

export const highlightedCodeRootSchema = z.strictObject({
  type: z.literal("root"),
  children: z.array(highlightedCodeNodeSchema),
});

export const richTextNodeSchema: z.ZodType<RichTextNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("text"), text: z.string() }),
    z.strictObject({
      type: z.literal("element"),
      tagName: richTextElementTagSchema,
      attributes: z.record(z.string(), richTextAttributeSchema),
      children: z.array(richTextNodeSchema),
    }),
    z.strictObject({
      type: z.literal("link"),
      url: z.string(),
      origin: z.string().nullable(),
      title: z.string().nullable(),
      children: z.array(richTextNodeSchema),
    }),
    z.strictObject({
      type: z.literal("code"),
      language: z.string().nullable(),
      title: z.string().nullable(),
      source: z.string(),
      highlighted: highlightedCodeRootSchema.nullable(),
    }),
    z.strictObject({ type: z.literal("mermaid"), source: z.string() }),
    z.strictObject({
      type: z.literal("media"),
      mediaType: z.enum(["image", "audio", "video", "file"]),
      source: z.enum(["asset", "external", "missing"]),
      assetId: z.string().nullable(),
      originalSource: z.string(),
      alt: z.string(),
      title: z.string().nullable(),
    }),
    z.strictObject({
      type: z.literal("alert"),
      kind: z.enum(["note", "tip", "important", "warning", "caution"]),
      children: z.array(richTextNodeSchema),
    }),
  ]),
);

export const richTextDocumentSchema = z.strictObject({
  type: z.literal("document"),
  children: z.array(richTextNodeSchema),
});

import { defaultSchema, type Options } from "rehype-sanitize";

function attributesFor(name: string): NonNullable<Options["attributes"]>[string] {
  return [...(defaultSchema.attributes?.[name] ?? [])];
}

export const richTextSanitizeSchema: Options = {
  ...defaultSchema,
  tagNames: [
    ...new Set([...(defaultSchema.tagNames ?? []), "details", "summary", "kbd", "section"]),
  ],
  attributes: {
    ...defaultSchema.attributes,
    a: [...attributesFor("a"), "dataOriginalHref"],
    code: [...attributesFor("code"), "dataLanguage", "dataMeta"],
    details: [...attributesFor("details"), "open"],
    img: [...attributesFor("img"), "dataOriginalSrc"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
    src: ["http", "https", "data"],
  },
  strip: [
    ...new Set([
      ...(defaultSchema.strip ?? []),
      "script",
      "style",
      "iframe",
      "object",
      "embed",
      "form",
      "audio",
      "video",
      "canvas",
      "template",
    ]),
  ],
};

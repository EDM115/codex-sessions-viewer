import { defaultSchema, type Options } from "rehype-sanitize";

const defaultAttributes = defaultSchema.attributes!;
const defaultTagNames = defaultSchema.tagNames!;
const defaultStrip = defaultSchema.strip!;

function attributesFor(name: string): NonNullable<Options["attributes"]>[string] {
  return [...(defaultAttributes[name] ?? [])];
}

export const richTextSanitizeSchema: Options = {
  ...defaultSchema,
  tagNames: [...new Set([...defaultTagNames, "details", "summary", "kbd", "section"])],
  attributes: {
    ...defaultAttributes,
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
      ...defaultStrip,
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

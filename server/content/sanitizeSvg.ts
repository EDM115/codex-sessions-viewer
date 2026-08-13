import rehypeRaw from "rehype-raw";
import rehypeSanitize, { type Options } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";

const svgTags = [
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
  "title",
  "desc",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
];
const shapeAttributes = [
  "id",
  "className",
  "d",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "width",
  "height",
  "points",
  "viewBox",
  "preserveAspectRatio",
  "fillOpacity",
  "fillRule",
  "strokeWidth",
  "strokeLinecap",
  "strokeLinejoin",
  "strokeOpacity",
  "strokeDasharray",
  "strokeDashoffset",
  "opacity",
  "transform",
  "gradientUnits",
  "gradientTransform",
  "offset",
  "stopColor",
  "stopOpacity",
  "role",
  "ariaLabel",
];
const safePaint =
  /^(?:[a-z][a-z-]*|#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d\s%.,+-]+\)|url\(#[a-z_][\w:.-]*\))$/iu;
const safeLocalReference = /^url\(#[a-z_][\w:.-]*\)$/iu;
const safeSvgAttributes: NonNullable<Options["attributes"]>[string] = [
  ...shapeAttributes,
  ["fill", safePaint],
  ["stroke", safePaint],
  ["clipPath", safeLocalReference],
  ["mask", safeLocalReference],
  ["xmlns", "http://www.w3.org/2000/svg"],
];

const svgSchema: Options = {
  tagNames: svgTags,
  attributes: Object.fromEntries(svgTags.map((tag) => [tag, safeSvgAttributes])),
  protocols: {},
  strip: [
    "script",
    "style",
    "foreignObject",
    "image",
    "a",
    "use",
    "animate",
    "animateMotion",
    "animateTransform",
    "set",
    "iframe",
    "object",
    "embed",
    "audio",
    "video",
  ],
};

export async function sanitizeSvg(source: string): Promise<string | null> {
  if (!/<svg(?:\s|>)/iu.test(source)) {
    return null;
  }
  try {
    const processor = unified().use(rehypeRaw).use(rehypeSanitize, svgSchema).use(rehypeStringify);
    const tree = await processor.run({
      type: "root",
      children: [{ type: "raw", value: source }],
    });
    const sanitized = processor.stringify(tree);
    return /<svg(?:\s|>)/iu.test(sanitized) ? sanitized : null;
  } catch {
    return null;
  }
}

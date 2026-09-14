// Only retain the declaration/value pairs produced by our local Shiki themes.
export function safeCodeStyle(style: string): string {
  const color =
    "(?:#[\\da-f]{6}(?:[\\da-f]{2})?|light-dark\\(#[\\da-f]{6}(?:[\\da-f]{2})?,\\s*#[\\da-f]{6}(?:[\\da-f]{2})?\\))";
  const allowed = new RegExp(
    `^(?:(?:background-color|color):${color}|font-style:(?:normal|italic)|font-weight:(?:normal|bold|[1-9]00)|text-decoration:(?:none|underline|line-through))$`,
    "iu",
  );
  return style
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => allowed.test(declaration))
    .join(";");
}

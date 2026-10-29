export function htmlElement(value: Element): HTMLElement {
  if (!(value instanceof HTMLElement)) {
    throw new Error("Expected an HTML element");
  }
  return value;
}
export function detailsElement(value: Element): HTMLDetailsElement {
  if (!(value instanceof HTMLDetailsElement)) {
    throw new Error("Expected a disclosure element");
  }
  return value;
}

export const PLACEHOLDER_TAX_ID = "20123456789";

const REMOVED_ELEMENTS: readonly { tag: string; pattern: RegExp }[] = [
  { tag: "script", pattern: /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi },
  { tag: "style", pattern: /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi },
  { tag: "noscript", pattern: /<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi },
];

function stripElementBodies(html: string): string {
  return REMOVED_ELEMENTS.reduce(
    (current, { tag, pattern }) =>
      current.replace(pattern, `<${tag} data-removed="capture"></${tag}>`),
    html,
  );
}

function stripControlCharacters(html: string): string {
  return Array.from(html, (character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && !["\n", "\r", "\t"].includes(character)) ||
      code === 127
      ? ""
      : character;
  }).join("");
}

function redactCredentials(html: string): string {
  return html
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,})?\b/g,
      "[REDACTADO]",
    )
    .replace(/\b(Bearer|Basic)\s+[^\s"'<>,;]+/gi, "$1 [REDACTADO]")
    .replace(
      /\b(authorization|cookie|set-cookie|token|secret|password|api[_-]?key|jwt|session)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"'<>;,]+)/gi,
      "$1$2[REDACTADO]",
    );
}

function neutralizeAttributes(html: string): string {
  return html
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(
      /(<iframe\b[^>]*?)\ssrc(?:doc)?\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
      "$1",
    )
    .replace(/\s(?:src|srcset)\s*=\s*("data:[^"]*"|'data:[^']*')/gi, "");
}

function replaceTaxIds(html: string): string {
  return html.replace(/(?<!\d)\d{11}(?!\d)/g, PLACEHOLDER_TAX_ID);
}

export function sanitizeCapturedHtml(html: string): string {
  if (typeof html !== "string")
    throw new TypeError("Captured HTML must be a string");
  return replaceTaxIds(
    redactCredentials(
      neutralizeAttributes(stripElementBodies(stripControlCharacters(html))),
    ),
  );
}

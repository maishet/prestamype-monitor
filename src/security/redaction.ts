export function redactSensitiveText(value: string): string {
  const clean = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && !["\n", "\r", "\t"].includes(character)) ||
      code === 127
      ? ""
      : character;
  }).join("");
  const sensitiveLabel =
    /\b(?:authorization|proxy[- ]authorization|cookie|set[- ]cookie|token|secret|password|api(?:[_ -]?key)|x-api-key|session|jwt)\b\s*[:/=]/i;
  const redactKnownTokens = (line: string): string =>
    line
      .replace(/\b\d{11}\b/g, "[REDACTADO]")
      .replace(
        /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,})?\b/g,
        "[REDACTADO]",
      )
      .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [REDACTADO]");
  return clean
    .split(/(\r?\n)/)
    .map((part) => {
      if (/^\r?\n$/.test(part)) return part;
      const label = sensitiveLabel.exec(part);
      if (label !== null) {
        const labelEnd = label.index + label[0].length;
        const whitespace = /^\s*/.exec(part.slice(labelEnd))?.[0] ?? "";
        return `${redactKnownTokens(part.slice(0, labelEnd))}${whitespace}[REDACTADO]`;
      }
      return redactKnownTokens(part);
    })
    .join("");
}

import { describe, expect, it } from "vitest";

import {
  PLACEHOLDER_TAX_ID,
  sanitizeCapturedHtml,
} from "../../src/cli/dom-capture-sanitizer.js";

describe("sanitizeCapturedHtml", () => {
  it("removes script bodies that can carry hydration secrets", () => {
    const output = sanitizeCapturedHtml(
      '<div><script>window.__NUXT__={token:"eyJhbGciOiJIUzI1NiJ9.abcdefgh.signature"}</script></div>',
    );
    expect(output).not.toContain("__NUXT__");
    expect(output).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(output).toContain('<script data-removed="capture"></script>');
  });

  it("keeps the business markup the parsers need", () => {
    const output = sanitizeCapturedHtml(
      '<tr class="row_table"><td class="cell">METALVAL S.A.C.</td><td>C</td><td>S/ 250,990.68</td></tr>',
    );
    expect(output).toContain('<tr class="row_table">');
    expect(output).toContain("METALVAL S.A.C.");
    expect(output).toContain("S/ 250,990.68");
  });

  it("replaces tax ids with a fixed placeholder without changing their shape", () => {
    const output = sanitizeCapturedHtml("<span>RUC 20517854523</span>");
    expect(output).toBe(`<span>RUC ${PLACEHOLDER_TAX_ID}</span>`);
    expect(output).not.toContain("20517854523");
  });

  it("leaves amounts and dates that merely look numeric untouched", () => {
    const output = sanitizeCapturedHtml(
      "<span>27.28% · 2026-09-03 · 250990.68</span>",
    );
    expect(output).toContain("27.28%");
    expect(output).toContain("2026-09-03");
    expect(output).toContain("250990.68");
  });

  it("redacts credential-shaped attributes and inline handlers", () => {
    const output = sanitizeCapturedHtml(
      '<a href="/x" onclick="steal()" data-token="abc123secret">ver</a>',
    );
    expect(output).not.toContain("onclick");
    expect(output).not.toContain("abc123secret");
    expect(output).toContain('href="/x"');
  });

  it("drops iframe sources", () => {
    const output = sanitizeCapturedHtml(
      '<iframe src="https://evil.example/x"></iframe>',
    );
    expect(output).not.toContain("evil.example");
  });
});

export type PageStructureErrorCode =
  "MISSING_FIELD" | "INVALID_FIELD" | "INVALID_URL" | "UNSUPPORTED_VALUE";

const SAFE_MESSAGES: Readonly<Record<PageStructureErrorCode, string>> = {
  MISSING_FIELD: "A required page field is missing",
  INVALID_FIELD: "A page field has an invalid format",
  INVALID_URL: "An opportunity link is not safe",
  UNSUPPORTED_VALUE: "A page field contains an unsupported value",
};

export class PageStructureError extends Error {
  readonly code: PageStructureErrorCode;
  readonly field: string;

  constructor(code: PageStructureErrorCode, field: string) {
    super(`${SAFE_MESSAGES[code]} (${field})`);
    this.name = "PageStructureError";
    this.code = code;
    this.field = field;
  }
}

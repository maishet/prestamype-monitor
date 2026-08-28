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

export class SessionChallengeError extends Error {
  constructor() {
    super("A browser challenge requires manual intervention");
    this.name = "SessionChallengeError";
  }
}

export class SessionExpiredError extends Error {
  constructor() {
    super("The Prestamype session is no longer authenticated");
    this.name = "SessionExpiredError";
  }
}

export class RateLimitError extends Error {
  readonly status: 403 | 429;

  constructor(status: 403 | 429) {
    super(`Prestamype rejected the browser request (${status})`);
    this.name = "RateLimitError";
    this.status = status;
  }
}

export class ScanDeadlineError extends Error {
  constructor() {
    super("The safe browser scan deadline was exceeded");
    this.name = "ScanDeadlineError";
  }
}

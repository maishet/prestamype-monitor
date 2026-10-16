import { describe, expect, it } from "vitest";
import {
  formatElapsed,
  formatLimaDateTime,
} from "../../src/notifications/lima-time.js";

describe("Lima time", () => {
  it("renders UTC instants in Lima with a 24-hour clock", () => {
    expect(formatLimaDateTime("2026-10-14T16:19:08.846Z")).toBe(
      "14/10/2026 11:19",
    );
    expect(formatLimaDateTime("2026-10-15T05:00:00.000Z")).toBe(
      "15/10/2026 00:00",
    );
    expect(formatLimaDateTime("2026-10-15T22:45:00.000Z")).toBe(
      "15/10/2026 17:45",
    );
    expect(formatLimaDateTime("not a date")).toBe("no disponible");
  });

  it("describes how long ago something happened", () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    expect(formatElapsed("2026-10-15T11:59:30.000Z", now)).toBe(
      "hace instantes",
    );
    expect(formatElapsed("2026-10-15T11:15:00.000Z", now)).toBe("hace 45 min");
    expect(formatElapsed("2026-10-14T12:00:00.000Z", now)).toBe("hace 24 h");
    expect(formatElapsed("2026-10-10T12:00:00.000Z", now)).toBe("hace 5 d");
  });
});

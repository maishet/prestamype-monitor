import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/defaults.js";

describe("DEFAULT_CONFIG", () => {
  it("accepts A+ through C and requires 15 percent annual return", () => {
    expect(DEFAULT_CONFIG.allowedRisks).toEqual(["A+", "A", "B", "C"]);
    expect(DEFAULT_CONFIG.minimumAnnualReturnPct).toBe(15);
    expect(DEFAULT_CONFIG.currency).toBe("PEN");
  });
});

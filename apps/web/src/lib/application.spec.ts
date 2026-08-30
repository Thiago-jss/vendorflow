import { describe, expect, it } from "vitest";
import { applicationName } from "./application";

describe("application shell", () => {
  it("identifies the application", () => {
    expect(applicationName).toBe("VendorFlow");
  });
});

import { describe, it, expect } from "vitest";
import {
  DEFAULT_HARNESS_READY_TIMEOUT_MS,
  HARNESS_READY_TIMEOUT_ENV,
  harnessReadyBoundNotice,
  harnessReadyTimeoutMs,
} from "../../src/browser/index.js";

const withBound = (value: string): NodeJS.ProcessEnv => ({ [HARNESS_READY_TIMEOUT_ENV]: value });

describe("the readiness bound", () => {
  it("is 90 seconds when the environment names none", () => {
    expect(harnessReadyTimeoutMs({})).toBe(90000);
    expect(DEFAULT_HARNESS_READY_TIMEOUT_MS).toBe(90000);
  });

  it("is the whole number of milliseconds the environment names", () => {
    expect(harnessReadyTimeoutMs(withBound("180000"))).toBe(180000);
  });

  it.each(["0", "-1", "12.5", "abc", "", "  "])(
    "falls back to the default for %j",
    (value) => {
      expect(harnessReadyTimeoutMs(withBound(value))).toBe(DEFAULT_HARNESS_READY_TIMEOUT_MS);
    },
  );
});

describe("a bound the environment names but this tool cannot use", () => {
  it("is disclosed once, naming the variable and the default that stands in", () => {
    const first = harnessReadyBoundNotice(withBound("soon"));

    expect(first).toContain(HARNESS_READY_TIMEOUT_ENV);
    expect(first).toContain("soon");
    expect(first).toContain(String(DEFAULT_HARNESS_READY_TIMEOUT_MS));
    expect(harnessReadyBoundNotice(withBound("soon"))).toBeUndefined();
  });

  it("stays silent for a usable value", () => {
    expect(harnessReadyBoundNotice(withBound("120000"))).toBeUndefined();
    expect(harnessReadyBoundNotice({})).toBeUndefined();
  });
});

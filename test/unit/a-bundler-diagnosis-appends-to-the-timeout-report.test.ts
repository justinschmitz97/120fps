import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BUNDLER_IMPORT_UNRESOLVED_ERROR,
  presentBundlerFailure,
} from "../../src/harness/index.js";

// twenty/n8n's shape: the diagnosis replaced the readiness report and took M125's wait note with it.
const READINESS_LEAD = "component harness did not become ready within timeout.";
const WAIT_NOTE =
  "It waited 90 s for the harness page to define window.__120fps. A machine busy with parallel " +
  "work, or a dependency pre-bundle running for the first time, can push that wait past the " +
  "bound. An import that never settles never ends it. FPS120_READY_TIMEOUT_MS=<milliseconds> " +
  "raises the bound (default 90000).";
const UNRESOLVED_IMPORT =
  'Failed to resolve import "@ui/utilities/utils/isDefined" from "../twenty-ui/src/theme-constants/ThemeProvider.tsx". Does the file exist?';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-diagnosis-append-"));
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "p" }));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function timeoutReport(pageError: string): string {
  return [`${READINESS_LEAD} Page errors:`, "  - [vite] Internal Server Error", pageError, WAIT_NOTE].join(
    "\n",
  );
}

describe("a bundler pattern inside the page-error block of a readiness report", () => {
  it("keeps the readiness sentence and the wait note, and adds the diagnosis below them", () => {
    const presented = presentBundlerFailure(timeoutReport(UNRESOLVED_IMPORT), tmpDir, []);

    expect(presented).toContain(READINESS_LEAD);
    expect(presented).toContain("It waited 90 s");
    expect(presented).toContain(
      BUNDLER_IMPORT_UNRESOLVED_ERROR(
        "@ui/utilities/utils/isDefined",
        "../twenty-ui/src/theme-constants/ThemeProvider.tsx",
      ),
    );
  });

  it("never leads with the diagnosis: the readiness sentence stays first", () => {
    const presented = presentBundlerFailure(timeoutReport(UNRESOLVED_IMPORT), tmpDir, []);

    expect(presented.startsWith(READINESS_LEAD)).toBe(true);
    expect(presented.indexOf("It waited 90 s")).toBeLessThan(
      presented.indexOf("which the dev server could not resolve"),
    );
  });

  it("appends to a fail-fast fatal report the same way", () => {
    const failFast = [
      "component harness failed before it became ready: env.mjs: boom. Page errors:",
      "  - [vite] Internal Server Error",
      UNRESOLVED_IMPORT,
    ].join("\n");

    const presented = presentBundlerFailure(failFast, tmpDir, []);

    expect(presented.startsWith("component harness failed before it became ready")).toBe(true);
    expect(presented).toContain("which the dev server could not resolve");
  });

  it("prints one diagnosis, not two", () => {
    const presented = presentBundlerFailure(timeoutReport(UNRESOLVED_IMPORT), tmpDir, []);
    const occurrences = presented.split("which the dev server could not resolve").length - 1;

    expect(occurrences).toBe(1);
  });

  it("keeps a readiness report that matches no bundler pattern byte-identical", () => {
    const report = timeoutReport("  - createEnv failed: NEXT_PUBLIC_API_URL is required");

    expect(presentBundlerFailure(report, tmpDir, [])).toBe(report);
  });
});

describe("a bundler failure that is itself the lead sentence", () => {
  it("is diagnosed in place, with no readiness report to keep", () => {
    const presented = presentBundlerFailure(UNRESOLVED_IMPORT, tmpDir, []);

    expect(presented).toBe(
      BUNDLER_IMPORT_UNRESOLVED_ERROR(
        "@ui/utilities/utils/isDefined",
        "../twenty-ui/src/theme-constants/ThemeProvider.tsx",
      ),
    );
  });

  it("still diagnoses a virtual-namespace import as its own lead sentence", () => {
    const presented = presentBundlerFailure(
      'Failed to resolve import "~icons/lucide/eye" from "src/components/smart/EnvInput.vue". Does the file exist?',
      tmpDir,
      [],
    );

    expect(presented).toContain("virtual namespace");
    expect(presented).not.toContain("did not become ready");
  });
});

// cli/errors.ts presents an unhandled rejection whose message may already be a presented report.
describe("presenting a report that was already presented", () => {
  it("prints one diagnosis, not a second copy of the same one", () => {
    const once = presentBundlerFailure(timeoutReport(UNRESOLVED_IMPORT), tmpDir, []);

    const twice = presentBundlerFailure(once, tmpDir, []);

    expect(twice).toBe(once);
  });

  it("stays stable over a third pass", () => {
    const once = presentBundlerFailure(timeoutReport(UNRESOLVED_IMPORT), tmpDir, []);

    expect(presentBundlerFailure(presentBundlerFailure(once, tmpDir, []), tmpDir, [])).toBe(once);
  });

  it("does not stack the mute-readiness stylesheet suspect either", () => {
    const warnings = ["Stylesheets: src/app.css (found in the project entry's own imports)"];
    const mute = "component harness did not become ready within timeout. No page errors were captured.";
    const once = presentBundlerFailure(mute, tmpDir, warnings);

    expect(presentBundlerFailure(once, tmpDir, warnings)).toBe(once);
  });
});

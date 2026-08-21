import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildAndServe, collectStaticPreBuildWarnings } from "../../src/harness.js";

const PROJECT = path.resolve("fixtures/vite-config-project");
const COMPONENT = path.join(PROJECT, "src", "widget.tsx");

// V6's rows 5 and 17-21: every one of these facts is a filesystem probe, and
// every one of them was reachable only by starting a dev server, so a dry run
// stayed silent about a config the real run reported on seconds later.
describe("pre-build facts a run can state without building", () => {
  it("names the vite.config keys the harness cannot honor", () => {
    const pre = collectStaticPreBuildWarnings(PROJECT, { componentPath: COMPONENT });
    const configWarning = pre.warnings.find((w) => w.startsWith("vite.config.ts"));
    expect(configWarning).toBeDefined();
    expect(configWarning).toContain("declares plugins");
  });

  it("starts no server and leaves no harness directory behind", () => {
    collectStaticPreBuildWarnings(PROJECT, { componentPath: COMPONENT });
    expect(fs.readdirSync(PROJECT).filter((n) => n.startsWith(".120fps-harness-"))).toEqual([]);
  });

  // I5's set-and-order pin: toEqual on arrays is order-sensitive, so this
  // fails if either path reorders or drops a warning the other keeps.
  it("produces the warnings the harness itself would produce", async () => {
    const pre = collectStaticPreBuildWarnings(PROJECT, { componentPath: COMPONENT });
    const harness = await buildAndServe(COMPONENT);
    try {
      expect(harness.warnings).toEqual([...new Set(pre.warnings)]);
    } finally {
      await harness.cleanup();
    }
  });


});

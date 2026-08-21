import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyze } from "../../src/analyze.js";
import type { ServerPool } from "../../src/harness.js";

// M90 harden: adversarial hypotheses against the catch-path accumulation fix.

function poolThatThrows(err: unknown): ServerPool {
  return {
    async acquire(): Promise<never> {
      throw err;
    },
    stats: () => ({ booted: 0 }),
    async closeAll() {},
  };
}

function installReactDom(root: string): void {
  const pkgDir = path.join(root, "node_modules", "react-dom");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "react-dom", version: "19.0.0", main: "index.js" }),
  );
  fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};");
  fs.writeFileSync(path.join(pkgDir, "client.js"), "module.exports = {};");
}

describe("M90 harden", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-m90-harden-"));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { react: "18.3.1", "react-dom": "18.3.1", unocss: "0.58.0" } }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "Button.tsx"),
      'import "unocss";\nexport default function Button() { return null; }\n',
    );
    installReactDom(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // #1: --no-css still discloses "Stylesheets: none (--no-css)" on a crash.
  it("#1 discloses the decision under --no-css", async () => {
    let thrown: Error | undefined;
    try {
      await analyze(path.join(tmpDir, "Button.tsx"), {
        noCss: true,
        serverPool: poolThatThrows(new Error("EADDRINUSE: port in use")),
      } as any);
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toContain("Stylesheets: none (--no-css)");
  });

  // #2: an unrelated pre-existing warning (unocss transform note) and the
  // css decision both survive together, deduped, neither dropping the other.
  it("#2 combines with an existing runWarnings entry without dropping either", async () => {
    let thrown: Error | undefined;
    try {
      await analyze(path.join(tmpDir, "Button.tsx"), {
        serverPool: poolThatThrows(new Error("EADDRINUSE: port in use")),
      });
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toContain("unocss");
    expect(thrown!.message).toContain("Stylesheets:");
    // Not literally duplicated in the accumulated block.
    const occurrences = thrown!.message.split("Stylesheets:").length - 1;
    expect(occurrences).toBe(1);
  });

  // #3: the caught value is preserved as .cause for a non-Error throw (not
  // dropped by the accumulation rewrap). buildAndServe (harness.ts) wraps
  // the original pool-acquire failure before analyze()'s own catch ever
  // sees it, so this checks structural content, not object identity.
  it("#3 preserves the original thrown value's content as .cause for a non-Error throw", async () => {
    const original = { code: "EBOOM" };
    let thrown: (Error & { cause?: unknown }) | undefined;
    try {
      await analyze(path.join(tmpDir, "Button.tsx"), {
        serverPool: poolThatThrows(original),
      });
      expect.unreachable();
    } catch (err) {
      thrown = err as Error & { cause?: unknown };
    }
    expect(thrown!.cause).toBeDefined();
    expect(JSON.stringify(thrown!.cause)).toContain("EBOOM");
  });

  // #4: repeated identical strings across runWarnings/carried/cssDecision
  // collapse to one line each (Set-based dedup untouched by the css addition).
  it("#4 does not duplicate an accumulated warning that already equals the css decision text", async () => {
    let thrown: Error | undefined;
    try {
      await analyze(path.join(tmpDir, "Button.tsx"), {
        serverPool: poolThatThrows(new Error("EADDRINUSE: port in use")),
      });
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    const stylesheetLines = (thrown!.message.match(/Stylesheets: none found[^\n]*/g) ?? []).length;
    expect(stylesheetLines).toBeLessThanOrEqual(1);
  });
});

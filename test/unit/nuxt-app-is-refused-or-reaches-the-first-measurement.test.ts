import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { explainProps } from "../../src/pipeline/index.js";
import { presentBundlerFailure } from "../../src/harness/index.js";
import { isNuxtProject, nuxtPrepareGap, preflightFailureMessage, runPreflight } from "../../src/project/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-nuxt-"));
  fs.mkdirSync(path.join(tmpDir, "node_modules"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, content: string): void {
  const file = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function nuxtProject(tsconfig: unknown, options: { generated?: string[] } = {}): void {
  write("package.json", JSON.stringify({ name: "app", dependencies: { nuxt: "^4.5.2" } }));
  write("nuxt.config.ts", "export default {};\n");
  write("tsconfig.json", JSON.stringify(tsconfig));
  write("components/Divider.tsx", "export const Divider = () => null;\n");
  for (const generated of options.generated ?? []) write(generated, "{}\n");
}

function preflight() {
  return runPreflight({
    projectRoot: tmpDir,
    entries: [path.join(tmpDir, "components", "Divider.tsx")],
  });
}

describe("recognising a Nuxt project", () => {
  it("counts a declared nuxt dependency", () => {
    write("package.json", JSON.stringify({ name: "app", dependencies: { nuxt: "^4.5.2" } }));

    expect(isNuxtProject(tmpDir)).toBe(true);
  });

  it("counts a nuxt.config even when the manifest does not name nuxt", () => {
    write("package.json", JSON.stringify({ name: "app", dependencies: {} }));
    write("nuxt.config.mjs", "export default {};\n");

    expect(isNuxtProject(tmpDir)).toBe(true);
  });

  it("does not count a project with neither", () => {
    write("package.json", JSON.stringify({ name: "app", dependencies: { react: "19.0.0" } }));

    expect(isNuxtProject(tmpDir)).toBe(false);
  });
});

describe("a Nuxt project whose tsconfig names a file .nuxt/ does not hold", () => {
  it("is a hard preflight hit, so the refusal happens before a browser starts", () => {
    nuxtProject({ extends: "./.nuxt/tsconfig.json" }, { generated: [".nuxt/imports.d.ts"] });

    const hit = preflight().hard.find((h) => h.kind === "nuxt-not-prepared");

    expect(hit?.nuxt?.missing).toBe(".nuxt/tsconfig.json");
    expect(hit?.nuxt?.config).toBe("tsconfig.json");
  });

  it("names the config, the missing file and the command that writes it", () => {
    nuxtProject({ extends: "./.nuxt/tsconfig.json" }, { generated: [".nuxt/imports.d.ts"] });

    const message = preflightFailureMessage(preflight().hard);

    expect(message).toContain("tsconfig.json");
    expect(message).toContain(".nuxt/tsconfig.json");
    expect(message).toContain("nuxi prepare");
  });

  it("fires when .nuxt/ is missing altogether, not only when it is incomplete", () => {
    nuxtProject({ extends: "./.nuxt/tsconfig.json" });

    expect(preflight().hard.some((h) => h.kind === "nuxt-not-prepared")).toBe(true);
  });

  it("reads a solution-style config's references, not only its extends", () => {
    nuxtProject(
      { files: [], references: [{ path: "./.nuxt/tsconfig.app.json" }] },
      { generated: [".nuxt/imports.d.ts"] },
    );

    expect(nuxtPrepareGap(tmpDir)?.missing).toBe(".nuxt/tsconfig.app.json");
  });

  it("refuses the dry run with the same string", async () => {
    nuxtProject({ extends: "./.nuxt/tsconfig.json" });
    const expected = preflightFailureMessage(preflight().hard);

    await expect(
      explainProps(path.join(tmpDir, "components", "Divider.tsx"), {}),
    ).rejects.toThrow(expected);
  });
});

describe("a Nuxt project whose .nuxt/ holds everything its tsconfig names", () => {
  it("is not refused, so a prepared app still reaches the browser", () => {
    nuxtProject(
      { files: [], references: [{ path: "./.nuxt/tsconfig.app.json" }] },
      { generated: [".nuxt/tsconfig.app.json"] },
    );

    expect(nuxtPrepareGap(tmpDir)).toBeUndefined();
    expect(preflight().hard).toEqual([]);
  });
});

describe("a project that is not Nuxt", () => {
  it("gets no nuxi prepare remedy however broken its tsconfig extends is", () => {
    write("package.json", JSON.stringify({ name: "app", dependencies: { react: "19.0.0" } }));
    write("tsconfig.json", JSON.stringify({ extends: "./.nuxt/tsconfig.json" }));
    write("components/Divider.tsx", "export const Divider = () => null;\n");

    expect(preflight().hard).toEqual([]);
  });
});

const MUTE_TIMEOUT = "component harness did not become ready within timeout. No page errors were captured.";
const STYLESHEET_PICK =
  "Stylesheets: app/assets/css/main.css (largest-stylesheet fallback, low confidence — verify with --css)";

describe("a readiness failure that captured no page error", () => {
  it("names the injected stylesheet and the two commands that decide it", () => {
    const message = presentBundlerFailure(MUTE_TIMEOUT, tmpDir, [STYLESHEET_PICK]);

    expect(message).toContain(MUTE_TIMEOUT);
    expect(message).toContain("app/assets/css/main.css");
    expect(message).toContain("--no-css");
    expect(message).toContain("--css");
  });

  it("ranks the stylesheet as a suspect rather than declaring it the cause", () => {
    const message = presentBundlerFailure(MUTE_TIMEOUT, tmpDir, [STYLESHEET_PICK]);

    expect(message).toContain("the shape of this failure");
    expect(message).not.toContain("The stylesheet is the cause");
  });

  it("says nothing about a stylesheet when the run injected none", () => {
    for (const decision of [
      "Stylesheets: none (--no-css)",
      "Stylesheets: none found (checked the project entry, conventional filenames, and the largest stylesheet under the project)",
      "Stylesheets: dropped after a read failure -- measured unstyled (see warnings)",
    ]) {
      expect(presentBundlerFailure(MUTE_TIMEOUT, tmpDir, [decision])).toBe(MUTE_TIMEOUT);
    }
  });

  it("says nothing when the failure did carry a page error, which names its own cause", () => {
    const withError = [
      "component harness did not become ready within timeout. Page errors:",
      "  - ReferenceError: __DEV__ is not defined",
    ].join("\n");

    expect(presentBundlerFailure(withError, tmpDir, [STYLESHEET_PICK])).toBe(withError);
  });

  it("keeps an explicitly named sheet in scope, which no compile probe drops", () => {
    const message = presentBundlerFailure(MUTE_TIMEOUT, tmpDir, [
      "Stylesheets: app/app.css (explicit --css)",
    ]);

    expect(message).toContain("app/app.css");
  });
});

import { describe, it, expect, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import {
  aliasedPackageMissingEntry,
  findLikelyGenerateCommand,
  packageManagerRunCommand,
  VITE_CONFIG_WORKSPACE_ROOT_ALIAS_WARNING,
} from "../../src/harness.js";
import {
  attachPageErrorCapture,
  enrichTimeoutError,
  waitForReadyOrFatal,
} from "../../src/page-errors.js";

const roots: string[] = [];

afterAll(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function mkRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-remedy-"));
  roots.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

// ant-design: `prepare` is `is-ci || husky && dumi setup`; the script that
// writes components/version/version.ts is `version`.
const ANT_DESIGN_SCRIPTS = {
  prepare: "is-ci || husky && dumi setup",
  build: "npm run compile",
  version: "tsx scripts/generate-version.ts",
};

describe("the script a missing generated file comes from", () => {
  it("prefers the script whose command names the generator over a lifecycle script", () => {
    const root = mkRepo({
      "package.json": JSON.stringify({ name: "antd", scripts: ANT_DESIGN_SCRIPTS }),
      "package-lock.json": "{}",
    });
    expect(findLikelyGenerateCommand(root, "components/version/version.ts")).toBe("npm run version");
  });

  it("prefers a script whose command names the missing path itself", () => {
    const root = mkRepo({
      "package.json": JSON.stringify({
        name: "app",
        scripts: { build: "tsc", "make-config": "node tools/emit.js > src/config.generated.ts" },
      }),
      "package-lock.json": "{}",
    });
    expect(findLikelyGenerateCommand(root, "src/config.generated.ts")).toBe("npm run make-config");
  });

  it("falls back to the codegen/build name list when no command references it", () => {
    const root = mkRepo({
      "package.json": JSON.stringify({ name: "app", scripts: { build: "tsc", test: "vitest" } }),
      "package-lock.json": "{}",
    });
    expect(findLikelyGenerateCommand(root, "src/gone.ts")).toBe("npm run build");
    expect(findLikelyGenerateCommand(root)).toBe("npm run build");
  });

  it("has nothing to name when the manifest declares no scripts", () => {
    const root = mkRepo({ "package.json": JSON.stringify({ name: "app" }) });
    expect(findLikelyGenerateCommand(root, "src/gone.ts")).toBeUndefined();
  });
});

describe("the package manager a repository actually uses", () => {
  it("reads the packageManager field first", () => {
    const root = mkRepo({
      "package.json": JSON.stringify({ name: "nuxt-ui", packageManager: "pnpm@11.22.0" }),
      "package-lock.json": "{}",
    });
    expect(packageManagerRunCommand(root, "build")).toBe("pnpm run build");
  });

  it("reads the lockfile when no field declares one", () => {
    const yarn = mkRepo({ "package.json": JSON.stringify({ name: "a" }), "yarn.lock": "" });
    expect(packageManagerRunCommand(yarn, "build")).toBe("yarn build");
    const pnpm = mkRepo({ "package.json": JSON.stringify({ name: "b" }), "pnpm-lock.yaml": "" });
    expect(packageManagerRunCommand(pnpm, "build")).toBe("pnpm run build");
  });

  it("reads the workspace root's lockfile for a member that has none", () => {
    const repo = mkRepo({
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      "pnpm-lock.yaml": "",
      "packages/ui/package.json": JSON.stringify({ name: "ui", scripts: { build: "x" } }),
    });
    expect(packageManagerRunCommand(path.join(repo, "packages", "ui"), "build")).toBe("pnpm run build");
  });

  it("falls back to npm when nothing says otherwise", () => {
    const root = mkRepo({ "package.json": JSON.stringify({ name: "a" }) });
    expect(packageManagerRunCommand(root, "version")).toBe("npm run version");
  });
});

// chakra-ui: packages/react/package.json main/module/types all point into a
// dist/ that does not exist, so the workspace-root alias is the only reason
// anything resolves at all.
describe("why an alias from the workspace root is load-bearing", () => {
  function chakra(distBuilt: boolean): string {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/app/package.json": JSON.stringify({ name: "app" }),
      "node_modules/@chakra-ui/react/package.json": JSON.stringify({
        name: "@chakra-ui/react",
        main: "dist/cjs/index.js",
        module: "dist/esm/index.js",
      }),
    };
    if (distBuilt) files["node_modules/@chakra-ui/react/dist/esm/index.js"] = "export {};";
    return mkRepo(files);
  }

  it("names the entry the package declares and has not built", () => {
    const root = chakra(false);
    const member = path.join(root, "packages", "app");
    expect(aliasedPackageMissingEntry("@chakra-ui/react", member)).toContain("index.js");
  });

  it("claims nothing when the declared entry exists", () => {
    const root = chakra(true);
    expect(
      aliasedPackageMissingEntry("@chakra-ui/react", path.join(root, "packages", "app")),
    ).toBeUndefined();
  });

  it("claims nothing about a package that is not installed", () => {
    const root = chakra(false);
    expect(aliasedPackageMissingEntry("@absent/pkg", path.join(root, "packages", "app"))).toBeUndefined();
  });

  // chakra's real shape: the aliased package is a workspace member, not an
  // install — `packages/react` itself, whose main/module point into a dist/
  // the repository has not built. Nothing under node_modules answers for it.
  it("follows the alias target to the workspace package that owns it", () => {
    const repo = mkRepo({
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/react/package.json": JSON.stringify({
        name: "@chakra-ui/react",
        main: "dist/cjs/index.cjs",
        module: "dist/esm/index.js",
      }),
      "packages/react/src/index.ts": "export {};",
    });
    const target = path.join(repo, "packages", "react", "src");
    expect(aliasedPackageMissingEntry("@chakra-ui/react", target, target)).toContain(
      "dist/esm/index.js",
    );
  });

  it("claims nothing when the alias target belongs to a different package", () => {
    const repo = mkRepo({
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/other/package.json": JSON.stringify({ name: "other", main: "dist/index.js" }),
      "packages/other/src/index.ts": "export {};",
    });
    const target = path.join(repo, "packages", "other", "src");
    expect(aliasedPackageMissingEntry("compositions", target, target)).toBeUndefined();
  });

  it("says why the alias matters when the declared entry is missing", () => {
    const withMissing = VITE_CONFIG_WORKSPACE_ROOT_ALIAS_WARNING(
      "@chakra-ui/react",
      "E:/repo/packages/react/src",
      "E:/repo/vite.config.ts",
      "packages/react/dist/esm/index.js",
    );
    expect(withMissing).toContain("came from the workspace root");
    expect(withMissing).toContain("packages/react/dist/esm/index.js");
    expect(withMissing).toContain("would not resolve");
    const withoutMissing = VITE_CONFIG_WORKSPACE_ROOT_ALIAS_WARNING(
      "@chakra-ui/react",
      "E:/repo/packages/react/src",
      "E:/repo/vite.config.ts",
    );
    expect(withoutMissing).not.toContain("would not resolve");
  });
});

// taxonomy: the run refuses with `Invalid environment variables` captured as a
// page error and prints no next step, while NO_ENV_FILE_REMEDY_NOTE was
// computed for that very run and only ever reached the fast-fail branch.
describe("the remedy for a refusal that arrived as a timeout", () => {
  const REMEDY = "No .env or .env.local found: add it to a .env file at the project root.";

  function fakePage(): { page: Page; emitter: EventEmitter } {
    const emitter = new EventEmitter();
    return { page: emitter as unknown as Page, emitter };
  }

  function timeout(): Error {
    const err = new Error("Timeout 30000ms exceeded.");
    err.name = "TimeoutError";
    return err;
  }

  it("appends the remedy to a timeout that captured page errors", () => {
    const { page, emitter } = fakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("pageerror", new Error("Invalid environment variables: NEXT_PUBLIC_APP_URL"));
    const enriched = enrichTimeoutError(timeout(), capture, "component harness", REMEDY);
    expect(enriched.message).toContain("did not become ready within timeout");
    expect(enriched.message).toContain("Invalid environment variables");
    expect(enriched.message).toContain(REMEDY);
  });

  it("says nothing about environment files for a hang that captured nothing", () => {
    const { page } = fakePage();
    const capture = attachPageErrorCapture(page);
    const enriched = enrichTimeoutError(timeout(), capture, "component harness", REMEDY);
    expect(enriched.message).toContain("No page errors were captured");
    expect(enriched.message).not.toContain(REMEDY);
  });

  it("carries the remedy through the readiness race when readiness rejects first", async () => {
    const { page, emitter } = fakePage();
    const capture = attachPageErrorCapture(page);
    emitter.emit("pageerror", new Error("Invalid environment variables: NEXT_PUBLIC_APP_URL"));
    let message = "";
    try {
      await waitForReadyOrFatal(() => Promise.reject(timeout()), capture, "component harness", () => REMEDY);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(REMEDY);
  });

  it("still leads with the page error itself when the fatal signal wins", async () => {
    const { page, emitter } = fakePage();
    const capture = attachPageErrorCapture(page);
    const pending = waitForReadyOrFatal(
      () => new Promise(() => {}),
      capture,
      "component harness",
      () => REMEDY,
    );
    emitter.emit("pageerror", new Error("Invalid environment variables"));
    await expect(pending).rejects.toThrow(/failed before it became ready/);
  });
});

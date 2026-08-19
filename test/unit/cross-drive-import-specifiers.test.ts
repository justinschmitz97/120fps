import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  componentImportPath,
  isOutsideRoot,
  fsAllowDirs,
  resolveWrapper,
} from "../../src/harness.js";

// path.win32 and path.posix are driven directly so drive-letter behavior is
// observable on any host.

describe("out-of-root detection across Windows drives", () => {
  it("treats another drive as outside, even though the relative form has no ..", () => {
    expect(path.win32.relative("C:\\proj", "D:\\x\\Button.tsx").startsWith("..")).toBe(false);
    expect(isOutsideRoot("D:\\x\\Button.tsx", "C:\\proj", path.win32)).toBe(true);
  });

  it("treats a nested path as inside", () => {
    expect(isOutsideRoot("C:\\proj\\src\\Button.tsx", "C:\\proj", path.win32)).toBe(false);
  });

  it("treats the root itself as inside", () => {
    expect(isOutsideRoot("C:\\proj", "C:\\proj", path.win32)).toBe(false);
  });

  it("treats a parent directory as outside", () => {
    expect(isOutsideRoot("C:\\Button.tsx", "C:\\proj", path.win32)).toBe(true);
    expect(isOutsideRoot("/Button.tsx", "/proj", path.posix)).toBe(true);
  });

  it("treats a sibling whose name shares the root prefix as outside", () => {
    expect(isOutsideRoot("/proj-two/Button.tsx", "/proj", path.posix)).toBe(true);
  });
});

describe("component import specifier for an in-root component", () => {
  it("is the forward-slashed relative path", () => {
    expect(componentImportPath("C:\\proj\\src\\Button.tsx", "C:\\proj", path.win32)).toBe(
      "src/Button.tsx",
    );
    expect(componentImportPath("/proj/src/Button.tsx", "/proj", path.posix)).toBe("src/Button.tsx");
  });
});

describe("component import specifier for a component outside the root", () => {
  it("routes another drive through /@fs/ instead of emitting a drive-letter path", () => {
    expect(componentImportPath("D:\\x\\Button.tsx", "C:\\proj", path.win32)).toBe(
      "@fs/D:/x/Button.tsx",
    );
  });

  it("routes a path above the root through /@fs/", () => {
    expect(componentImportPath("/other/Button.tsx", "/proj", path.posix)).toBe(
      "@fs/other/Button.tsx",
    );
  });
});

describe("fs.allow list with extra directories", () => {
  it("returns undefined when nothing is outside the member root", () => {
    const root = process.cwd();
    expect(fsAllowDirs(root, root, [], [path.join(root, "src")])).toBeUndefined();
  });

  it("keeps today's answer when no extra directories are given", () => {
    const root = process.cwd();
    expect(fsAllowDirs(root, root, [])).toBeUndefined();
  });

  it("forces the list to exist and to contain an outside directory", () => {
    const root = path.resolve("/proj");
    const workspace = path.resolve("/");
    const outside = path.resolve("/elsewhere/components");
    const allow = fsAllowDirs(root, workspace, [], [outside]);
    expect(allow).toBeDefined();
    expect(allow).toContain(outside.replace(/\\/g, "/"));
    expect(allow).toContain(root.replace(/\\/g, "/"));
  });
});

describe("wrapper resolution against the project root", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-wrap-root-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accepts a wrapper inside the root and returns its relative path", () => {
    const projectRoot = path.join(tmpDir, "proj");
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    const wrapper = path.join(projectRoot, "src", "Wrap.tsx");
    fs.writeFileSync(wrapper, "export default function Wrap({ children }) { return children; }\n");
    expect(resolveWrapper(wrapper, projectRoot)).toBe("src/Wrap.tsx");
  });

  it("rejects a wrapper outside the root", () => {
    const projectRoot = path.join(tmpDir, "proj");
    fs.mkdirSync(projectRoot, { recursive: true });
    const wrapper = path.join(tmpDir, "Wrap.tsx");
    fs.writeFileSync(wrapper, "export default function Wrap({ children }) { return children; }\n");
    expect(() => resolveWrapper(wrapper, projectRoot)).toThrow(/must live inside the project root/);
  });
});

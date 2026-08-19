import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fsAllowDirs } from "../../src/harness.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mkWorkspace(): { root: string; member: string; shared: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-fsallow-"));
  cleanupDirs.push(root);
  const member = path.join(root, "packages", "ui");
  const shared = path.join(root, "packages", "shared", "src");
  fs.mkdirSync(path.join(member, "src"), { recursive: true });
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, "index.ts"), "export const x = 1;\n");
  return { root, member, shared };
}

const fwd = (p: string) => p.replace(/\\/g, "/");

// Vite refuses to serve a file outside its allow list, and the harness root is
// the member package: an alias pointing at a sibling package is exactly the
// path that a monorepo needs and a single-package repo never has.
describe("dev server file access for alias targets", () => {
  it("keeps Vite's defaults when every alias target is inside the member root", () => {
    const { member } = mkWorkspace();
    const aliases = [{ find: /^@\//, replacement: `${fwd(member)}/src/` }];

    expect(fsAllowDirs(member, member, aliases)).toBeUndefined();
  });

  it("keeps Vite's defaults when there are no aliases at all", () => {
    const { root, member } = mkWorkspace();
    expect(fsAllowDirs(member, root, [])).toBeUndefined();
  });

  it("allows the member root, the workspace root, and the outside target", () => {
    const { root, member, shared } = mkWorkspace();
    const aliases = [
      { find: /^@\//, replacement: `${fwd(member)}/src/` },
      { find: /^@shared\//, replacement: `${fwd(shared)}/` },
    ];

    const allow = fsAllowDirs(member, root, aliases);

    expect(allow).toContain(fwd(member));
    expect(allow).toContain(fwd(root));
    expect(allow).toContain(fwd(shared));
  });

  it("contributes the containing directory of a file target", () => {
    const { root, member, shared } = mkWorkspace();
    const aliases = [{ find: /^#tokens$/, replacement: `${fwd(shared)}/index.ts` }];

    const allow = fsAllowDirs(member, root, aliases);

    expect(allow).toContain(fwd(shared));
    expect(allow).not.toContain(`${fwd(shared)}/index.ts`);
  });

  it("lists each directory once", () => {
    const { root, member, shared } = mkWorkspace();
    const aliases = [
      { find: /^@a\//, replacement: `${fwd(shared)}/` },
      { find: /^@b\//, replacement: `${fwd(shared)}/` },
    ];

    const allow = fsAllowDirs(member, root, aliases)!;

    expect(allow).toEqual([...new Set(allow)]);
  });
});

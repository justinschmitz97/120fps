import fs from "node:fs";
import path from "node:path";

// Nearest ancestor of startDir containing a .git entry (directory or, for a
// worktree, file); undefined outside any repo. Independent of
// project-model.ts's findWorkspaceRoot, which walks looking for install
// artifacts (lockfiles, workspaces field), not a git repo specifically.
export function findGitRoot(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

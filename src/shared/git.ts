import fs from "node:fs";
import path from "node:path";

// Not findWorkspaceRoot (project/model.ts): that walk finds installs, not repos.
export function findGitRoot(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  while (true) {
    // existsSync: a worktree's .git is a file.
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

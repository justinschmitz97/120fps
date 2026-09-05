import fs from "node:fs";
import path from "node:path";
import { findWorkspaceRoot, readProjectManifest } from "./model.js";
import { toPosix } from "../shared/index.js";

// The packageManager field wins over the lockfile, and the member's lockfile over the root's.
export type PackageManager = "npm" | "pnpm" | "yarn";

const LOCKFILE_MANAGER: Array<[string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

export function detectPackageManager(root: string): PackageManager {
  // A declaration beats an artifact: a stray package-lock.json in a pnpm member must not win.
  const levels: string[] = [];
  let cursor = path.resolve(root);
  // findWorkspaceRoot stops at a member with a stray lockfile, so this walk goes up to .git.
  while (true) {
    levels.push(cursor);
    if (fs.existsSync(path.join(cursor, ".git"))) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const workspaceRoot = findWorkspaceRoot(root);
  if (!levels.includes(workspaceRoot)) levels.push(workspaceRoot);
  for (const level of levels) {
    const declared = readProjectManifest(level)?.packageManager;
    if (typeof declared !== "string") continue;
    const name = declared.split("@")[0].trim();
    if (name === "pnpm" || name === "yarn" || name === "npm") return name;
  }
  for (const level of [root, workspaceRoot]) {
    for (const [file, manager] of LOCKFILE_MANAGER) {
      if (fs.existsSync(path.join(level, file))) return manager;
    }
  }
  return "npm";
}

// startDir is a parameter, not a read of `process.cwd()`, so the message is a function of it.
export function runDirectoryPrefix(root: string, startDir: string): string {
  const target = path.resolve(root);
  const from = path.resolve(startDir);
  if (target === from) return "";
  const relative = path.relative(from, target);
  const dir = relative === "" || path.isAbsolute(relative) ? target : toPosix(relative);
  // A directory whose name contains a space is not pasteable unquoted.
  return `cd ${/\s/.test(dir) ? `"${dir}"` : dir} && `;
}

// yarn runs a script by bare name; npm and pnpm need `run` outside their lifecycle names.
export function packageManagerRunCommand(root: string, script: string, startDir?: string): string {
  const manager = detectPackageManager(root);
  const run = manager === "yarn" ? `yarn ${script}` : `${manager} run ${script}`;
  return startDir === undefined ? run : runDirectoryPrefix(root, startDir) + run;
}

// npm installs, pnpm and yarn add; all three take -D for a build-time dependency.
export function packageManagerAddCommand(root: string, pkg: string, startDir?: string): string {
  const manager = detectPackageManager(root);
  const add = manager === "npm" ? `npm install -D ${pkg}` : `${manager} add -D ${pkg}`;
  return startDir === undefined ? add : runDirectoryPrefix(root, startDir) + add;
}

// The install an already-declared dependency needs: the manifest is right, node_modules is not.
export function packageManagerInstallCommand(root: string, startDir?: string): string {
  const install = `${detectPackageManager(root)} install`;
  return startDir === undefined ? install : runDirectoryPrefix(root, startDir) + install;
}

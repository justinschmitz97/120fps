import fs from "node:fs";
import path from "node:path";

// Advisory only: nothing in this file writes to .gitignore.
export const GITIGNORE_SUGGESTED_PATTERNS = [
  "120fps-report*.json",
  "120fps-baseline.json",
  ".120fps-harness-*",
];

// Only the patterns this run's own writes need, so a report-only run never asks for more.
export function formatGitignoreTip(patterns: string[]): string {
  if (patterns.length === 0) return "";
  return (
    "Tip: 120fps writes report/baseline files into this repo. Consider adding to .gitignore: " +
    patterns.join(", ")
  );
}

// Literal or one `*` only; an unrecognized pattern yields an extra hint, never a suppressed one.
export function gitignoreCoversFile(gitignoreContent: string, filename: string): boolean {
  for (const rawLine of gitignoreContent.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const pattern = line.replace(/^\//, "").replace(/\/$/, "");
    if (pattern === filename) return true;
    const star = pattern.indexOf("*");
    if (star === -1 || pattern.indexOf("*", star + 1) !== -1) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      filename.length >= prefix.length + suffix.length &&
      filename.startsWith(prefix) &&
      filename.endsWith(suffix)
    ) {
      return true;
    }
  }
  return false;
}

// A missing .gitignore covers nothing, so the check still runs against empty content.
export function needsGitignoreAdvisory(gitRoot: string, writtenFilenames: string[]): boolean {
  const gitignorePath = path.join(gitRoot, ".gitignore");
  const content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf-8") : "";
  return writtenFilenames.some((name) => !gitignoreCoversFile(content, name));
}

function suggestedPatternFor(writtenPath: string): string | undefined {
  const name = path.basename(writtenPath);
  if (name.startsWith(".120fps-harness-")) return ".120fps-harness-*";
  if (name === "120fps-baseline.json") return "120fps-baseline.json";
  if (/^120fps-report.*\.json$/.test(name)) return "120fps-report*.json";
  return undefined;
}

export function gitignoreTipPatterns(gitRoot: string, writtenPaths: string[]): string[] {
  const asked = new Set<string>();
  for (const written of writtenPaths) {
    const pattern = suggestedPatternFor(written);
    if (!pattern || asked.has(pattern)) continue;
    // Resolved path, not basename: a file written outside the repo is not its hygiene problem.
    const relative = path.relative(gitRoot, path.resolve(written));
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    if (!needsGitignoreAdvisory(gitRoot, [path.basename(written)])) continue;
    asked.add(pattern);
  }
  return GITIGNORE_SUGGESTED_PATTERNS.filter((pattern) => asked.has(pattern));
}

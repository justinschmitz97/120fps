import fs from "node:fs";
import path from "node:path";

// M74 (E5): the tool writes 120fps-report*.json and 120fps-baseline.json
// straight into the user's repo with no gitignore awareness. This is a hint,
// never a file edit: nothing below ever writes to .gitignore.
export const GITIGNORE_SUGGESTED_PATTERNS = [
  "120fps-report*.json",
  "120fps-baseline.json",
  ".120fps-harness-*",
];

// M117 A2: the tip names the patterns the paths that fired it need, so a run
// that only wrote a report does not ask for the baseline and harness patterns
// it never produced. No patterns, no tip.
export function formatGitignoreTip(patterns: string[]): string {
  if (patterns.length === 0) return "";
  return (
    "Tip: 120fps writes report/baseline files into this repo. Consider adding to .gitignore: " +
    patterns.join(", ")
  );
}

// Literal match or a single `*` wildcard (prefix/suffix around it) only: no
// gitignore glob engine (no `**`, character classes, negation, or
// directory-scoped rules). One wildcard is the level a user actually writes
// by hand, and it is also the shape of every pattern this file itself
// suggests (GITIGNORE_SUGGESTED_PATTERNS), so a user who already took the
// hint stops seeing it. A pattern this fails to recognize (two or more
// wildcards, a character class, a directory-scoped rule) produces an extra
// hint, never a suppressed one.
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

// A missing .gitignore covers nothing, so every written filename is
// uncovered; never a reason to skip the check.
export function needsGitignoreAdvisory(gitRoot: string, writtenFilenames: string[]): boolean {
  const gitignorePath = path.join(gitRoot, ".gitignore");
  const content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf-8") : "";
  return writtenFilenames.some((name) => !gitignoreCoversFile(content, name));
}

// The suggested pattern one written path asks for, or nothing for a path this
// tool did not produce.
function suggestedPatternFor(writtenPath: string): string | undefined {
  const name = path.basename(writtenPath);
  if (name.startsWith(".120fps-harness-")) return ".120fps-harness-*";
  if (name === "120fps-baseline.json") return "120fps-baseline.json";
  if (/^120fps-report.*\.json$/.test(name)) return "120fps-report*.json";
  return undefined;
}

// M117 A1 (shadcn-admin/dialog-real2.log:67): the gate mapped every written
// report through path.basename, so a report written to a directory outside the
// repository still counted as written into it. The resolved path decides now: a
// file this run wrote outside the repository is not that repository's hygiene
// problem, whatever it is called.
export function gitignoreTipPatterns(gitRoot: string, writtenPaths: string[]): string[] {
  const asked = new Set<string>();
  for (const written of writtenPaths) {
    const pattern = suggestedPatternFor(written);
    if (!pattern || asked.has(pattern)) continue;
    const relative = path.relative(gitRoot, path.resolve(written));
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    if (!needsGitignoreAdvisory(gitRoot, [path.basename(written)])) continue;
    asked.add(pattern);
  }
  return GITIGNORE_SUGGESTED_PATTERNS.filter((pattern) => asked.has(pattern));
}

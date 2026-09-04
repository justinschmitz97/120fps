import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ADR 0005 (specs/decisions/0005-module-layout-by-pipeline-stage.md): src/ is
// stage directories, value imports point downward, and a value import into
// another directory goes through that directory's index.js. This test is the
// enforcement the ADR names; specs/milestones/M118-MAP.md holds the table.

const SRC = path.resolve("src");

// Rows import from columns, per the M118 map's "Allowed value-import edges".
// "" is src/index.ts: the package surface, which re-exports every stage.
const ALLOWED_EDGES: Record<string, readonly string[]> = {
  "": ["shared", "project", "props", "report", "harness", "browser", "analysis", "pipeline", "cli"],
  cli: ["shared", "project", "props", "report", "harness", "browser", "analysis", "pipeline"],
  pipeline: ["shared", "project", "props", "report", "harness", "browser", "analysis"],
  analysis: ["shared", "project", "props", "report", "harness", "browser"],
  browser: ["shared", "project", "props", "harness"],
  harness: ["shared", "project", "props"],
  report: ["shared", "project", "props", "browser"],
  props: ["shared", "project"],
  project: ["shared"],
  shared: [],
};

// The edges that exist after M118 wave 1. Wave 2 and wave 3 empty this list;
// the assertions below fail both when a new violation appears and when an
// entry here stops violating, so the list cannot lag behind the tree.
const ALLOWLIST: readonly { file: string; target: string; reason: string }[] = [];

interface Edge {
  file: string;
  line: number;
  typeOnly: boolean;
  spec: string;
  fromDir: string;
  toDir: string;
  viaIndex: boolean;
}

function listSources(dir: string, prefix = "", out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "shims") continue;
      listSources(path.join(dir, entry.name), `${prefix}${entry.name}/`, out);
    } else if (entry.name.endsWith(".ts")) {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return out;
}

function parentOf(rel: string): string {
  const slash = rel.lastIndexOf("/");
  return slash === -1 ? "" : rel.slice(0, slash);
}

// The stage a path belongs to. A stage may group files in a nested directory
// (src/pipeline/modes); those files are part of their stage, so an import
// between them is not a cross-directory edge and needs no index.js hop.
function directoryOf(rel: string): string {
  const slash = rel.indexOf("/");
  return slash === -1 ? "" : rel.slice(0, slash);
}

// One import or export statement, however many lines its clause spans.
const STATEMENT = /^[ \t]*(?:import|export)\b([\s\S]*?)from\s*"([^"]+)";?[ \t]*$/;

function readEdges(): Edge[] {
  const edges: Edge[] = [];
  for (const rel of listSources(SRC)) {
    const fromParent = parentOf(rel);
    const fromDir = directoryOf(rel);
    const lines = fs.readFileSync(path.join(SRC, rel), "utf8").split("\n");
    let buffer: string | null = null;
    let startLine = 0;
    for (let i = 0; i < lines.length; i++) {
      if (buffer === null) {
        if (!/^(import|export)\b/.test(lines[i])) continue;
        buffer = lines[i];
        startLine = i + 1;
      } else {
        buffer += ` ${lines[i].trim()}`;
      }
      const match = STATEMENT.exec(buffer);
      if (!match) {
        // Not an import after all (a declaration whose body began at column 0).
        if (buffer.includes(";") && !/[,{]\s*$/.test(buffer)) buffer = null;
        continue;
      }
      const [, clause, spec] = match;
      buffer = null;
      // `import ... from "./${stem}"` inside a generated-entry template is
      // output text, not an edge of this package.
      if (!spec.startsWith(".") || spec.includes("${")) continue;
      const target = path.posix.normalize(path.posix.join(fromParent, spec));
      edges.push({
        file: rel,
        line: startLine,
        typeOnly: /^\s*type\b/.test(clause),
        spec,
        fromDir,
        toDir: directoryOf(target),
        viaIndex: /(^|\/)index\.js$/.test(spec),
      });
    }
  }
  return edges;
}

const EDGES = readEdges();
const CROSS_VALUE = EDGES.filter((e) => !e.typeOnly && e.fromDir !== e.toDir);
const key = (e: { file: string; target: string }) => `${e.file} -> ${e.target}`;

describe("module boundaries (ADR 0005)", () => {
  it("finds the imports it is meant to police", () => {
    expect(EDGES.length).toBeGreaterThan(150);
    expect(CROSS_VALUE.length).toBeGreaterThan(100);
  });

  it("routes every cross-directory value import through the target's index.js", () => {
    const offenders = CROSS_VALUE.filter((e) => !e.viaIndex).map(
      (e) => `${e.file}:${e.line} ${e.fromDir || "(root)"} -> ${e.spec}`,
    );
    expect(offenders).toEqual([]);
  });

  it("keeps every cross-directory value import inside the allowed edge table", () => {
    const violations = CROSS_VALUE.filter(
      (e) => !(ALLOWED_EDGES[e.fromDir] ?? []).includes(e.toDir),
    );
    const detail = violations.map(
      (e) => `${e.file}:${e.line} ${e.fromDir || "(root)"} -> ${e.toDir}`,
    );
    const observed = [...new Set(violations.map((e) => key({ file: e.file, target: e.toDir })))].sort();
    const allowed = [...new Set(ALLOWLIST.map(key))].sort();
    // Both directions: a new violation fails, and so does an allowlist entry
    // whose edge is gone, so the list shrinks with the tree.
    expect({ observed, detail: detail.length ? detail : undefined }).toEqual({
      observed: allowed,
      detail: detail.length ? detail : undefined,
    });
  });

  it("has no value cycle among directories once the allowlisted edges are removed", () => {
    const allowed = new Set(ALLOWLIST.map(key));
    const graph = new Map<string, Set<string>>();
    for (const e of CROSS_VALUE) {
      if (allowed.has(key({ file: e.file, target: e.toDir }))) continue;
      if (!graph.has(e.fromDir)) graph.set(e.fromDir, new Set());
      graph.get(e.fromDir)!.add(e.toDir);
    }
    const cycles: string[] = [];
    const state = new Map<string, 0 | 1 | 2>();
    const walk = (node: string, trail: string[]): void => {
      state.set(node, 1);
      for (const next of graph.get(node) ?? []) {
        if (state.get(next) === 1) {
          cycles.push([...trail, node, next].join(" -> "));
          continue;
        }
        if (state.get(next) === undefined) walk(next, [...trail, node]);
      }
      state.set(node, 2);
    };
    for (const node of graph.keys()) if (state.get(node) === undefined) walk(node, []);
    expect(cycles).toEqual([]);
  });
});

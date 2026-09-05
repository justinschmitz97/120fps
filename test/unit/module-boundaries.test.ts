import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ADR: specs/decisions/0005-module-layout-by-pipeline-stage.md; edges: specs/milestones/M118-MAP.md

const SRC = path.resolve("src");

// Rows import from columns; matches the ADR's allowed edge table.
const ALLOWED_EDGES: Record<string, readonly string[]> = {
  // "" is src/index.ts: the package surface that re-exports every stage.
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

// This allowlist empties across waves; assertions fail if it lags the tree in either direction.
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

// A nested directory (src/pipeline/modes) is still part of its parent stage, not a cross edge.
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
      // A generated-entry template's "./${stem}" is output text, not an edge of this package.
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

// import("x").Foo is a type query, not a dynamic import; the trailing .Member marks it typeOnly.
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)(\s*\.)?/g;

function readDynamicEdges(): Edge[] {
  const edges: Edge[] = [];
  for (const rel of listSources(SRC)) {
    const fromParent = parentOf(rel);
    const fromDir = directoryOf(rel);
    const text = fs.readFileSync(path.join(SRC, rel), "utf8");
    DYNAMIC_IMPORT.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DYNAMIC_IMPORT.exec(text))) {
      const [, spec, dot] = match;
      if (!spec.startsWith(".") || spec.includes("${")) continue;
      const target = path.posix.normalize(path.posix.join(fromParent, spec));
      edges.push({
        file: rel,
        line: text.slice(0, match.index).split("\n").length,
        typeOnly: Boolean(dot),
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
const DYNAMIC_EDGES = readDynamicEdges();
const STATIC_CROSS_VALUE = EDGES.filter((e) => !e.typeOnly && e.fromDir !== e.toDir);
const DYNAMIC_CROSS_VALUE = DYNAMIC_EDGES.filter((e) => !e.typeOnly && e.fromDir !== e.toDir);
// A dynamic import() never runs during evaluation, so it can't close a load-order cycle.
const CROSS_VALUE = [...STATIC_CROSS_VALUE, ...DYNAMIC_CROSS_VALUE];
const key = (e: { file: string; target: string }) => `${e.file} -> ${e.target}`;

describe("module boundaries (ADR 0005)", () => {
  it("finds the imports it is meant to police", () => {
    expect(EDGES.length).toBeGreaterThan(150);
    expect(STATIC_CROSS_VALUE.length).toBeGreaterThan(100);
    expect(DYNAMIC_EDGES.length).toBeGreaterThan(0);
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
    // Fails both ways: a new violation, and an allowlist entry whose edge is gone.
    expect({ observed, detail: detail.length ? detail : undefined }).toEqual({
      observed: allowed,
      detail: detail.length ? detail : undefined,
    });
  });

  it("has no value cycle among directories once the allowlisted edges are removed", () => {
    const allowed = new Set(ALLOWLIST.map(key));
    const graph = new Map<string, Set<string>>();
    for (const e of STATIC_CROSS_VALUE) {
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

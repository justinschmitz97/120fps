import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnvFile, readEnvDefines } from "../../src/harness.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-env-define-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relative: string, body: string): string {
  const full = path.join(tmpDir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
}

describe("parsing a .env file", () => {
  it("reads plain KEY=VALUE lines", () => {
    expect(parseEnvFile("A=1\nB=two")).toEqual({ A: "1", B: "two" });
  });

  it("ignores blank lines and comments", () => {
    expect(parseEnvFile("# note\n\nA=1\n   # indented\n")).toEqual({ A: "1" });
  });

  it("accepts an export prefix", () => {
    expect(parseEnvFile("export A=1")).toEqual({ A: "1" });
  });

  it("strips one layer of surrounding quotes", () => {
    expect(parseEnvFile(`A="one"\nB='two'\nC="'three'"`)).toEqual({
      A: "one",
      B: "two",
      C: "'three'",
    });
  });

  it("keeps everything after the first equals sign", () => {
    expect(parseEnvFile("URL=https://x.test/?a=1&b=2")).toEqual({
      URL: "https://x.test/?a=1&b=2",
    });
  });

  it("trims surrounding whitespace from key and value", () => {
    expect(parseEnvFile("  A = 1  ")).toEqual({ A: "1" });
  });

  it("does not interpolate other variables", () => {
    expect(parseEnvFile("A=1\nB=${A}/x")).toEqual({ A: "1", B: "${A}/x" });
  });

  it("skips a line with no equals sign", () => {
    expect(parseEnvFile("JUST_A_NAME\nA=1")).toEqual({ A: "1" });
  });

  it("skips a key that is not a valid identifier", () => {
    expect(parseEnvFile("not-a-key=1\nA=1")).toEqual({ A: "1" });
  });

  it("reads a file with CRLF line endings", () => {
    expect(parseEnvFile("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });
});

describe("building browser defines from a project's env files", () => {
  it("always defines a process.env object so a bare read cannot throw", () => {
    expect(readEnvDefines(tmpDir)).toEqual({ "process.env": "{}" });
  });

  it("defines each public key exactly", () => {
    write(".env", "NEXT_PUBLIC_API=https://api.test\nVITE_FLAG=on");
    expect(readEnvDefines(tmpDir)).toEqual({
      "process.env": "{}",
      "process.env.NEXT_PUBLIC_API": '"https://api.test"',
      "process.env.VITE_FLAG": '"on"',
    });
  });

  it("never defines a key without a public prefix", () => {
    write(".env", "DATABASE_URL=postgres://secret\nAPI_SECRET=hunter2\nVITE_OK=1");
    const defines = readEnvDefines(tmpDir);
    expect(Object.keys(defines)).toEqual(["process.env", "process.env.VITE_OK"]);
  });

  it("lets .env.local override .env", () => {
    write(".env", "VITE_MODE=staging");
    write(".env.local", "VITE_MODE=local");
    expect(readEnvDefines(tmpDir)["process.env.VITE_MODE"]).toBe('"local"');
  });

  it("lets the member root override the workspace root", () => {
    const member = path.join(tmpDir, "packages", "app");
    fs.mkdirSync(member, { recursive: true });
    write(".env", "VITE_MODE=root\nVITE_SHARED=shared");
    fs.writeFileSync(path.join(member, ".env"), "VITE_MODE=member");
    const defines = readEnvDefines(member, tmpDir);
    expect(defines["process.env.VITE_MODE"]).toBe('"member"');
    expect(defines["process.env.VITE_SHARED"]).toBe('"shared"');
  });

  it("escapes a value that would break the injected object", () => {
    write(".env", 'VITE_TEXT=say "hi"');
    expect(readEnvDefines(tmpDir)["process.env.VITE_TEXT"]).toBe('"say \\"hi\\""');
  });

  it("orders the catch-all before every specific key once Vite sorts them", () => {
    write(".env", "VITE_A=1\nNEXT_PUBLIC_B=2");
    // Vite serializes defines with sorted keys and its client runtime assigns
    // them in that order, so the catch-all must never land last.
    const sorted = Object.keys(readEnvDefines(tmpDir)).sort();
    expect(sorted[0]).toBe("process.env");
  });
});

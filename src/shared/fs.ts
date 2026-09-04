import fs from "node:fs";
import path from "node:path";

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export function resolvePosix(p: string): string {
  return toPosix(path.resolve(p));
}

export function pathKey(file: string): string {
  const forward = resolvePosix(file);
  return process.platform === "win32" ? forward.toLowerCase() : forward;
}

export function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

export function readJsonFile(candidate: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(candidate, "utf-8"));
  } catch {
    return undefined;
  }
}

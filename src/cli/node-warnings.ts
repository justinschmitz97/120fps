import path from "node:path";
import { fileURLToPath } from "node:url";

// Node emits this about the *measured project's* config file, which 120fps loaded on the reader's
// behalf. The reader did not ask for it and cannot act on it from here.
const PROJECT_CONFIG_WARNING_CODE = "MODULE_TYPELESS_PACKAGE_JSON";

// Tags the installed listener, so a second call finds it instead of stacking another.
const FILTER_TAG = Symbol.for("120fps.moduleTypeWarningFilter");

type WarningListener = (warning: Error) => void;

// The message names the module twice: once as a file URL, once as the package.json to edit.
const FILE_URL_IN_MESSAGE = /file:\/\/\S+/;

export function warningFilename(warning: Error & { filename?: string }): string | undefined {
  if (typeof warning.filename === "string") return warning.filename;
  const match = FILE_URL_IN_MESSAGE.exec(warning.message ?? "");
  if (!match) return undefined;
  try {
    return fileURLToPath(match[0]);
  } catch {
    return undefined;
  }
}

function insideOwnTree(file: string, ownRoot: string): boolean {
  const relative = path.relative(path.resolve(ownRoot), path.resolve(file));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function suppressesWarning(
  warning: Error & { code?: string; filename?: string },
  ownRoot: string,
): boolean {
  if (warning.code !== PROJECT_CONFIG_WARNING_CODE) return false;
  const file = warningFilename(warning);
  if (file === undefined) return false;
  return !insideOwnTree(file, ownRoot);
}

// Node's own printer is a listener; filtering means re-registering it behind this one.
export function filterProjectModuleTypeWarnings(ownRoot: string): void {
  const existing = process.listeners("warning") as WarningListener[];
  if (existing.some((listener) => (listener as never as Record<symbol, unknown>)[FILTER_TAG])) {
    return;
  }
  for (const listener of existing) process.removeListener("warning", listener);
  const filtered: WarningListener = (warning) => {
    if (suppressesWarning(warning, ownRoot)) return;
    for (const listener of existing) listener.call(process, warning);
  };
  (filtered as never as Record<symbol, unknown>)[FILTER_TAG] = true;
  process.on("warning", filtered);
}

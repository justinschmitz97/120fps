import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWrapPath, WRAPPER_FROM_WORKSPACE_ROOT_WARNING } from "../../src/analyze.js";

let root: string;
let member: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-wrap-ws-"));
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - member\n");
  member = path.join(root, "member");
  fs.mkdirSync(member, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// M76: resolveWrapPath(options, projectRoot, framework, warningsOut?) probes
// workspaceRoot only when the member itself has none.
describe("resolveWrapPath: workspace-root fallback (M76)", () => {
  it("finds a wrapper at the workspace root when the member has none, and discloses it", () => {
    const wrap = path.join(root, "120fps.setup.tsx");
    fs.writeFileSync(wrap, "export default function Wrap({ children }) { return children; }\n");
    const warnings: string[] = [];

    const result = resolveWrapPath({}, member, "react", warnings);

    expect(result.wrapPath).toBe(wrap);
    expect(result.wrapAutoDetected).toBe(true);
    expect(warnings).toEqual([WRAPPER_FROM_WORKSPACE_ROOT_WARNING(wrap, member)]);
  });

  it("uses the member's own wrapper and never probes the workspace root", () => {
    const memberWrap = path.join(member, "120fps.setup.tsx");
    fs.writeFileSync(memberWrap, "export default function Wrap({ children }) { return children; }\n");
    fs.writeFileSync(
      path.join(root, "120fps.setup.tsx"),
      "export default function RootWrap({ children }) { return children; }\n",
    );
    const warnings: string[] = [];

    const result = resolveWrapPath({}, member, "react", warnings);

    expect(result.wrapPath).toBe(memberWrap);
    expect(result.wrapAutoDetected).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("stays silent when neither level has a wrapper", () => {
    const warnings: string[] = [];
    const result = resolveWrapPath({}, member, "react", warnings);
    expect(result.wrapPath).toBeUndefined();
    expect(result.wrapAutoDetected).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("--no-wrap short-circuits before either probe runs", () => {
    fs.writeFileSync(
      path.join(root, "120fps.setup.tsx"),
      "export default function RootWrap({ children }) { return children; }\n",
    );
    const warnings: string[] = [];
    const result = resolveWrapPath({ noWrap: true }, member, "react", warnings);
    expect(result.wrapPath).toBeUndefined();
    expect(result.wrapAutoDetected).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("an explicit --wrap path short-circuits before either probe runs", () => {
    const explicit = path.join(member, "custom.wrap.tsx");
    fs.writeFileSync(explicit, "export default function W({ children }) { return children; }\n");
    fs.writeFileSync(
      path.join(root, "120fps.setup.tsx"),
      "export default function RootWrap({ children }) { return children; }\n",
    );
    const warnings: string[] = [];
    const result = resolveWrapPath({ wrapPath: explicit }, member, "react", warnings);
    expect(result.wrapPath).toBe(explicit);
    expect(result.wrapAutoDetected).toBe(false);
    expect(warnings).toEqual([]);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readViteConfigData,
  VITE_CONFIG_WORKSPACE_ROOT_ALIAS_WARNING,
  VITE_CONFIG_WORKSPACE_ROOT_CONDITIONS_WARNING,
} from "../../src/harness.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-vite-ws-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mkdir(relative: string): string {
  const full = path.join(tmpDir, relative);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

function write(relative: string, content: string): string {
  const full = path.join(tmpDir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

// M76: readViteConfigData(projectRoot, workspaceRoot) additive second layer,
// chakra-ui's exact shape (root vite.config.ts, no vite.config.ts at the
// member at all).
describe("readViteConfigData: workspace-root fallback (M76)", () => {
  it("merges a workspace-root resolve.alias key the member's own config does not declare", () => {
    mkdir("packages/react/src");
    write(
      "vite.config.ts",
      "export default { resolve: { alias: { '@chakra-ui/react': './packages/react/src' } } };",
    );
    const member = mkdir("packages/react");

    const data = readViteConfigData(member, tmpDir);
    expect(data.aliases).toHaveLength(1);
    expect(data.aliases[0].find.test("@chakra-ui/react")).toBe(true);
    expect(data.aliases[0].replacement).toBe(
      path.join(tmpDir, "packages/react/src").replace(/\\/g, "/"),
    );
    expect(data.warnings).toEqual([
      VITE_CONFIG_WORKSPACE_ROOT_ALIAS_WARNING(
        "@chakra-ui/react",
        path.join(tmpDir, "packages/react/src").replace(/\\/g, "/"),
        path.join(tmpDir, "vite.config.ts").replace(/\\/g, "/"),
      ),
    ]);
  });

  it("a member key of the same name wins, and no warning fires for it", () => {
    mkdir("packages/react/root-src");
    mkdir("packages/react/member-src");
    write(
      "vite.config.ts",
      "export default { resolve: { alias: { '@chakra-ui/react': './packages/react/root-src' } } };",
    );
    const member = mkdir("packages/react");
    write("packages/react/vite.config.ts", "export default { resolve: { alias: { '@chakra-ui/react': './member-src' } } };");

    const data = readViteConfigData(member, tmpDir);
    expect(data.aliases).toHaveLength(1);
    expect(data.aliases[0].replacement).toBe(
      path.join(tmpDir, "packages/react/member-src").replace(/\\/g, "/"),
    );
    expect(data.warnings).toEqual([]);
  });

  it("is skipped entirely for a single-package project (workspaceRoot === projectRoot)", () => {
    write("vite.config.ts", "export default { root: '.' };");
    expect(readViteConfigData(tmpDir)).toEqual({
      configFile: path.join(tmpDir, "vite.config.ts"),
      aliases: [],
      ignoredKeys: [],
      conditions: [],
      warnings: [],
    });
  });

  it("merges resolve.conditions from the workspace root when the member declares none", () => {
    write("vite.config.ts", "export default { resolve: { conditions: ['custom-condition'] } };");
    const member = mkdir("packages/react");

    const data = readViteConfigData(member, tmpDir);
    expect(data.conditions).toEqual(["custom-condition"]);
    expect(data.warnings).toEqual([
      VITE_CONFIG_WORKSPACE_ROOT_CONDITIONS_WARNING(
        ["custom-condition"],
        path.join(tmpDir, "vite.config.ts").replace(/\\/g, "/"),
      ),
    ]);
  });

  it("a member's own resolve.conditions wins outright, with no merge and no warning", () => {
    write("vite.config.ts", "export default { resolve: { conditions: ['root-condition'] } };");
    const member = mkdir("packages/react");
    write(
      "packages/react/vite.config.ts",
      "export default { resolve: { conditions: ['member-condition'] } };",
    );

    const data = readViteConfigData(member, tmpDir);
    expect(data.conditions).toEqual(["member-condition"]);
    expect(data.warnings).toEqual([]);
  });
});

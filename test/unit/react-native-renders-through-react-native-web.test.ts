import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { REACT_NATIVE_WEB_ALIAS_WARNING, scanExternalDeps } from "../../src/harness/index.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mkProject(
  installed: string[],
  componentSource: string,
  // Packages whose own manifest declares react-native, the shape a native module publishes.
  nativeModules: string[] = [],
): { root: string; component: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-react-native-"));
  cleanupDirs.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "app" }));
  for (const pkg of [...installed, ...nativeModules]) {
    const dir = path.join(root, "node_modules", pkg);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: pkg,
        main: "./index.js",
        ...(nativeModules.includes(pkg) ? { peerDependencies: { "react-native": "*" } } : {}),
      }),
    );
    fs.writeFileSync(path.join(dir, "index.js"), "export const View = null;\n");
  }
  const component = path.join(root, "src", "Divider.tsx");
  fs.mkdirSync(path.dirname(component), { recursive: true });
  fs.writeFileSync(component, componentSource);
  return { root, component };
}

function scan(project: { root: string; component: string }): {
  deps: string[];
  aliases: Array<{ find: RegExp; replacement: string }>;
  warnings: string[];
} {
  const aliases: Array<{ find: RegExp; replacement: string }> = [];
  const warnings: string[] = [];
  const deps = scanExternalDeps(
    project.component,
    project.root,
    [],
    undefined,
    warnings,
    project.root,
    aliases,
  );
  return { deps, aliases, warnings };
}

const RN_COMPONENT = 'import {View} from "react-native";\nexport default function D() { return View; }\n';

describe("a component that imports react-native", () => {
  it("is measured against react-native-web when the project installs it", () => {
    const project = mkProject(["react-native", "react-native-web"], RN_COMPONENT);

    const { deps, aliases, warnings } = scan(project);

    const alias = aliases.find((a) => a.find.test("react-native"));
    expect(alias?.replacement).toBe(
      fs.realpathSync(path.join(project.root, "node_modules", "react-native-web")).replace(/\\/g, "/"),
    );
    expect(alias!.find.test("react-native-svg")).toBe(false);
    expect(deps).toContain("react-native-web");
    expect(deps).not.toContain("react-native");
    expect(warnings).toEqual([REACT_NATIVE_WEB_ALIAS_WARNING("node_modules/react-native-web")]);
  });

  it("stops with a message naming the layer when react-native-web is missing", () => {
    const project = mkProject(["react-native"], RN_COMPONENT);

    expect(() => scan(project)).toThrowError(/react-native-web/);
    expect(() => scan(project)).toThrowError(/React Native/);
    expect(() => scan(project)).toThrowError(/Divider\.tsx/);
  });

  it("stops and names the native modules its graph reaches", () => {
    const project = mkProject(
      ["react-native", "react-native-web"],
      'import {View} from "react-native";\nimport Svg from "react-native-svg";\nexport default [View, Svg];\n',
      ["react-native-svg"],
    );

    expect(() => scan(project)).toThrowError(/react-native-svg/);
    expect(() => scan(project)).toThrowError(/React Native modules/);
  });
});

describe("a component that imports no react-native", () => {
  it("gets no alias, no disclosure and an unchanged pre-bundle list", () => {
    const project = mkProject(
      ["react-native-web"],
      'import {clsx} from "clsx";\nexport default clsx;\n',
    );

    const { deps, aliases, warnings } = scan(project);

    expect(aliases).toHaveLength(0);
    expect(warnings.some((w) => w.includes("react-native-web"))).toBe(false);
    expect(deps).toEqual(["clsx"]);
  });
});

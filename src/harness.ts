import { createServer, type ViteDevServer } from "vite";
import fs from "node:fs";
import path from "node:path";
import type { CompositionTree, CompositionNode, ExportInfo } from "./composition.js";

export interface ShimEntry {
  module: string;
  shimFile: string;
}

export const SHIM_MODULES: ShimEntry[] = [
  { module: "next/image", shimFile: "next-image.js" },
  { module: "next/dynamic", shimFile: "next-dynamic.js" },
  { module: "next/link", shimFile: "next-link.js" },
  { module: "next/navigation", shimFile: "next-navigation.js" },
  { module: "next/headers", shimFile: "next-headers.js" },
  { module: "next-video/player", shimFile: "next-video-player.js" },
];

export function detectNextJs(projectRoot: string): boolean {
  const pkgPath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return "next" in deps;
  } catch {
    return false;
  }
}

export function buildShimAliases(
  hasNextJs: boolean,
): Array<{ find: RegExp; replacement: string }> {
  if (!hasNextJs) return [];
  const shimDir = path.resolve(import.meta.dirname ?? __dirname, "shims");
  return SHIM_MODULES.map((entry) => {
    const escaped = entry.module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
      find: new RegExp(`^${escaped}$`),
      replacement: path.join(shimDir, entry.shimFile),
    };
  });
}

export interface HarnessResult {
  url: string;
  server: ViteDevServer;
  componentPath: string;
  harnessDir: string;
  cleanup: () => Promise<void>;
  nextJsShims?: string[];
}

export interface BuildHarnessOptions {
  composition?: CompositionTree;
  exports?: ExportInfo[];
  noShims?: boolean;
}

export async function buildAndServe(
  componentPath: string,
  options?: BuildHarnessOptions,
): Promise<HarnessResult> {
  const absoluteComponentPath = path.resolve(componentPath);
  if (!fs.existsSync(absoluteComponentPath)) {
    throw new Error(`Component file not found: ${componentPath}`);
  }

  const componentDir = path.dirname(absoluteComponentPath);
  const projectRoot = findProjectRoot(componentDir) ?? componentDir;

  // Place harness files inside the target project so Vite resolves aliases
  const harnessDir = fs.mkdtempSync(
    path.join(projectRoot, ".120fps-harness-"),
  );
  const harnessDirName = path.basename(harnessDir);

  const componentRelative = path.relative(projectRoot, absoluteComponentPath).replace(/\\/g, "/");

  let entryTsx: string;

  if (options?.composition) {
    entryTsx = generateComposedEntry(componentRelative, options.composition, options.exports);
  } else {
    const { name: componentName, isDefaultOnly } = detectComponentExport(absoluteComponentPath);
    const hasScale = detectScaleExport(absoluteComponentPath);

    const importLine = isDefaultOnly
      ? `import ${componentName}${hasScale ? ", { scale as __120fps_scale }" : ""} from "/${componentRelative}";`
      : `import { ${componentName} as Component${hasScale ? ", scale as __120fps_scale" : ""} } from "/${componentRelative}";`;

    const componentRef = isDefaultOnly ? componentName : "Component";

    const autoScaleRender = `if (typeof props.__120fps_scaleN === "number") {
      const n = props.__120fps_scaleN;
      const { __120fps_scaleN: _, ...restProps } = props;
      root.render(createElement("div", null,
        ...Array.from({ length: n }, (_, i) => createElement(${componentRef}, { ...restProps, key: i }))
      ));
    } else {
      root.render(createElement(${componentRef}, props));
    }`;

    const scaleMount = hasScale
      ? `if (typeof props.__120fps_scaleN === "number" && typeof __120fps_scale === "function") {
      root.render(__120fps_scale(props.__120fps_scaleN));
    } else {
      root.render(createElement(${componentRef}, props));
    }`
      : autoScaleRender;

    const scaleRerender = hasScale
      ? `if (typeof props.__120fps_scaleN === "number" && typeof __120fps_scale === "function") {
      root.render(__120fps_scale(props.__120fps_scaleN));
    } else {
      root.render(createElement(${componentRef}, props));
    }`
      : autoScaleRender;

    entryTsx = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
${importLine}

const container = document.getElementById("root")!;
let root = createRoot(container);
let mounted = false;

(window as any).__120fps = {
  mount(props: any = {}) {
    if (mounted) {
      root.unmount();
      root = createRoot(container);
    }
    ${scaleMount}
    mounted = true;
  },
  unmount() {
    if (mounted) {
      root.unmount();
      root = createRoot(container);
      mounted = false;
    }
  },
  rerender(props: any = {}) {
    ${scaleRerender}
  },
  getContainer() {
    return container;
  },
};

`;
  }

  const indexHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>120fps harness</title></head>
<body><div id="root"></div><script type="module" src="./entry.tsx"></script></body>
</html>`;

  fs.writeFileSync(path.join(harnessDir, "entry.tsx"), entryTsx);
  fs.writeFileSync(path.join(harnessDir, "index.html"), indexHtml);

  const tsconfigAliases = loadTsconfigAliases(projectRoot);
  const externalDeps = scanExternalDeps(absoluteComponentPath, projectRoot, tsconfigAliases);

  const hasNextJs = !options?.noShims && detectNextJs(projectRoot);
  const shimAliases = buildShimAliases(hasNextJs);
  const alias = [...tsconfigAliases, ...shimAliases];

  let activeShims: string[] | undefined;
  if (hasNextJs) {
    const shimModules = new Set(SHIM_MODULES.map((s) => s.module));
    activeShims = externalDeps.filter((d) => shimModules.has(d));
    if (activeShims.length === 0) activeShims = undefined;
  }

  const server = await createServer({
    root: projectRoot,
    logLevel: "silent",
    server: {
      port: 0,
      strictPort: false,
    },
    resolve: {
      alias,
      dedupe: ["react", "react-dom"],
    },
    optimizeDeps: {
      include: ["react", "react-dom/client", ...externalDeps],
    },
  });

  await server.listen();

  const address = server.httpServer?.address();
  let url: string;
  if (address && typeof address === "object") {
    url = `http://localhost:${address.port}/${harnessDirName}/`;
  } else {
    throw new Error("Failed to start Vite dev server");
  }

  const cleanup = async () => {
    await server.close();
    fs.rmSync(harnessDir, { recursive: true, force: true });
  };

  return { url, server, componentPath: absoluteComponentPath, harnessDir, cleanup, nextJsShims: activeShims };
}

function findProjectRoot(dir: string): string | undefined {
  let current = dir;
  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripJsonComments(str: string): string {
  let result = "";
  let i = 0;
  while (i < str.length) {
    if (str[i] === '"') {
      result += '"';
      i++;
      while (i < str.length && str[i] !== '"') {
        if (str[i] === '\\') { result += str[i++]; }
        if (i < str.length) { result += str[i++]; }
      }
      if (i < str.length) { result += str[i++]; }
    } else if (str[i] === '/' && str[i + 1] === '/') {
      while (i < str.length && str[i] !== '\n') i++;
    } else if (str[i] === '/' && str[i + 1] === '*') {
      i += 2;
      while (i < str.length && !(str[i] === '*' && str[i + 1] === '/')) i++;
      i += 2;
    } else {
      result += str[i++];
    }
  }
  return result;
}

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"];

function resolveLocalImport(
  fromFile: string,
  spec: string,
  projectRoot: string,
  aliases: Array<{ find: RegExp; replacement: string }>,
): string | null {
  let resolved: string;
  if (spec.startsWith(".") || spec.startsWith("/")) {
    resolved = path.resolve(path.dirname(fromFile), spec);
  } else {
    let matched = false;
    let aliasedPath = spec;
    for (const { find, replacement } of aliases) {
      if (find.test(spec)) {
        aliasedPath = spec.replace(find, replacement);
        matched = true;
        break;
      }
    }
    if (!matched) return null;
    resolved = path.isAbsolute(aliasedPath) ? aliasedPath : path.resolve(projectRoot, aliasedPath);
  }

  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  for (const ext of EXTENSIONS) {
    const withExt = resolved + ext;
    if (fs.existsSync(withExt)) return withExt;
  }
  for (const ext of EXTENSIONS) {
    const indexFile = path.join(resolved, "index" + ext);
    if (fs.existsSync(indexFile)) return indexFile;
  }
  return null;
}

function scanExternalDeps(
  componentPath: string,
  projectRoot: string,
  aliases: Array<{ find: RegExp; replacement: string }>,
): string[] {
  const externalPkgs = new Set<string>();
  const visited = new Set<string>();
  const queue = [componentPath];

  while (queue.length > 0) {
    const file = queue.shift()!;
    const normalizedFile = path.resolve(file);
    if (visited.has(normalizedFile)) continue;
    visited.add(normalizedFile);

    let content: string;
    try {
      content = fs.readFileSync(normalizedFile, "utf-8");
    } catch {
      continue;
    }

    const importRegex = /(?:^|\s)(?:import|export)\s.*?from\s+["']([^"']+)["']|(?:^|\s)import\s+["']([^"']+)["']/gm;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const spec = match[1] ?? match[2];
      if (!spec) continue;

      const localResolved = resolveLocalImport(normalizedFile, spec, projectRoot, aliases);
      if (localResolved) {
        queue.push(localResolved);
      } else if (!spec.startsWith(".") && !spec.startsWith("/")) {
        const pkg = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : spec.split("/")[0];
        externalPkgs.add(pkg);
      }
    }
  }

  externalPkgs.delete("react");
  externalPkgs.delete("react-dom");

  const BLOCKED = new Set([
    "next", "webpack", "critters", "fibers",
    "react-server-dom-webpack", "react-server-dom-turbopack",
    "@vercel/turbopack-ecmascript-runtime",
    "@next/env", "@next/swc-linux-x64-gnu", "@next/swc-linux-x64-musl",
    "@next/swc-darwin-arm64", "@next/swc-darwin-x64",
    "@next/swc-win32-x64-msvc", "@next/swc-win32-arm64-msvc",
    "sass", "less", "stylus", "lightningcss", "sugarss",
  ]);

  for (const pkg of externalPkgs) {
    if (BLOCKED.has(pkg) || pkg.startsWith("@next/") || pkg.startsWith("@vercel/turbopack")) {
      externalPkgs.delete(pkg);
    }
  }

  return [...externalPkgs];
}

function loadTsconfigAliases(
  projectRoot: string,
): Array<{ find: RegExp; replacement: string }> {
  const tsconfigPath = path.join(projectRoot, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) return [];

  try {
    const raw = fs.readFileSync(tsconfigPath, "utf-8");
    let tsconfig: any;
    try {
      tsconfig = JSON.parse(raw);
    } catch {
      const stripped = stripJsonComments(raw);
      tsconfig = JSON.parse(stripped);
    }
    const paths: Record<string, string[]> | undefined =
      tsconfig?.compilerOptions?.paths;
    if (!paths) return [];

    const baseUrl = tsconfig?.compilerOptions?.baseUrl ?? ".";
    const base = path.resolve(projectRoot, baseUrl);

    const aliases: Array<{ find: RegExp; replacement: string }> = [];
    for (const [pattern, targets] of Object.entries(paths)) {
      if (!targets.length) continue;
      const target = targets[0];
      if (pattern.endsWith("/*") && target.endsWith("/*")) {
        const prefix = pattern.slice(0, -2);
        const dir = path.resolve(base, target.slice(0, -2)).replace(/\\/g, "/");
        aliases.push({ find: new RegExp(`^${escapeRegex(prefix)}/`), replacement: dir + "/" });
      } else {
        const resolved = path.resolve(base, target).replace(/\\/g, "/");
        aliases.push({ find: new RegExp(`^${escapeRegex(pattern)}$`), replacement: resolved });
      }
    }
    return aliases;
  } catch {
    return [];
  }
}

export function detectScaleExport(filePath: string): boolean {
  const content = fs.readFileSync(filePath, "utf-8");
  return /export\s+(?:function|const)\s+scale\b/.test(content);
}

function detectComponentExport(filePath: string): {
  name: string;
  isDefaultOnly: boolean;
} {
  const content = fs.readFileSync(filePath, "utf-8");

  // Default exports take priority — the default is the primary component
  const defaultFnMatch = content.match(
    /export\s+default\s+function\s+([A-Z]\w*)/,
  );
  if (defaultFnMatch) return { name: defaultFnMatch[1], isDefaultOnly: true };

  const defaultConstMatch = content.match(
    /export\s+default\s+(?:const\s+)?([A-Z]\w*)/,
  );
  if (defaultConstMatch)
    return { name: defaultConstMatch[1], isDefaultOnly: true };

  // Re-export as default: export { Name as default }
  const reExportDefaultMatch = content.match(
    /export\s+\{\s*([A-Z]\w*)\s+as\s+default\s*\}/,
  );
  if (reExportDefaultMatch) return { name: reExportDefaultMatch[1], isDefaultOnly: false };

  // Named exports (no default found)
  const namedFnMatch = content.match(
    /export\s+function\s+([A-Z]\w*)/,
  );
  if (namedFnMatch) return { name: namedFnMatch[1], isDefaultOnly: false };

  const namedConstMatch = content.match(
    /export\s+const\s+([A-Z]\w*)\s*(?::[^=]+)?\s*=/,
  );
  if (namedConstMatch) return { name: namedConstMatch[1], isDefaultOnly: false };

  const namedClassMatch = content.match(
    /export\s+class\s+([A-Z]\w*)/,
  );
  if (namedClassMatch) return { name: namedClassMatch[1], isDefaultOnly: false };

  // Re-export: export { Name } or export { Name, ... }
  const reExportBlock = content.match(/export\s+\{([^}]+)\}/);
  if (reExportBlock) {
    const items = reExportBlock[1].split(",");
    for (const item of items) {
      const cleaned = item.replace(/\/\*[\s\S]*?\*\//g, "").trim();
      if (cleaned.startsWith("type ")) continue;
      const m = cleaned.match(/^([A-Z]\w*)/);
      if (m) return { name: m[1], isDefaultOnly: false };
    }
  }

  // Fallback: derive from filename, assume default export
  const basename = path.basename(filePath, path.extname(filePath));
  const name = basename.charAt(0).toUpperCase() + basename.slice(1);
  return { name, isDefaultOnly: true };
}

function collectComponents(node: CompositionNode, set: Set<string>): void {
  if (node.component !== "__text__") set.add(node.component);
  for (const child of node.children) collectComponents(child, set);
}

function nodeToJsx(node: CompositionNode): string {
  if (node.component === "__text__") {
    return JSON.stringify((node.props as any).text ?? "");
  }

  const propsEntries = Object.entries(node.props);
  const propsStr = propsEntries
    .map(([k, v]) => {
      if (typeof v === "boolean") return v ? k : `${k}={false}`;
      if (typeof v === "string") return `${k}=${JSON.stringify(v)}`;
      return `${k}={${JSON.stringify(v)}}`;
    })
    .join(" ");

  const opening = propsStr ? `<${node.component} ${propsStr}>` : `<${node.component}>`;

  if (node.children.length === 0) {
    return propsStr ? `<${node.component} ${propsStr} />` : `<${node.component} />`;
  }

  const childrenJsx = node.children.map(nodeToJsx).join("\n");
  return `${opening}\n${childrenJsx}\n</${node.component}>`;
}

export function compositionToJsx(tree: CompositionTree): string {
  if (tree.structure.length === 0) return "";
  return nodeToJsx(tree.structure[0]);
}

function generateComposedEntry(componentRelative: string, tree: CompositionTree, exports?: ExportInfo[]): string {
  const components = new Set<string>();
  for (const node of tree.structure) collectComponents(node, components);

  const defaultExports = new Set(exports?.filter((e) => e.isDefault).map((e) => e.name) ?? []);
  const namedImports = [...components].filter((n) => !defaultExports.has(n)).sort();
  const defaultImport = [...components].find((n) => defaultExports.has(n));

  const parts: string[] = [];
  if (defaultImport) parts.push(defaultImport);
  if (namedImports.length > 0) parts.push(`{ ${namedImports.join(", ")} }`);
  const importLine = `import ${parts.join(", ")} from "/${componentRelative}";`;
  const jsx = compositionToJsx(tree);

  return `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
${importLine}

const ComposedScene = () => (
${jsx}
);

const container = document.getElementById("root")!;
let root = createRoot(container);
let mounted = false;

(window as any).__120fps = {
  mount(props: any = {}) {
    if (mounted) {
      root.unmount();
      root = createRoot(container);
    }
    root.render(<ComposedScene {...props} />);
    mounted = true;
  },
  unmount() {
    if (mounted) {
      root.unmount();
      root = createRoot(container);
      mounted = false;
    }
  },
  rerender(props: any = {}) {
    root.render(<ComposedScene {...props} />);
  },
  getContainer() {
    return container;
  },
};

`;
}

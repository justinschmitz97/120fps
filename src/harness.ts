import { createServer, type ViteDevServer } from "vite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface HarnessResult {
  url: string;
  server: ViteDevServer;
  cleanup: () => Promise<void>;
}

export async function buildAndServe(
  componentPath: string,
): Promise<HarnessResult> {
  const absoluteComponentPath = path.resolve(componentPath);
  if (!fs.existsSync(absoluteComponentPath)) {
    throw new Error(`Component file not found: ${componentPath}`);
  }

  const harnessDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "120fps-harness-"),
  );

  const componentImportPath = absoluteComponentPath.replace(/\\/g, "/");

  const { name: componentName, isDefaultOnly } = detectComponentExport(absoluteComponentPath);

  const importLine = isDefaultOnly
    ? `import ${componentName} from "${componentImportPath}";`
    : `import { ${componentName} as Component } from "${componentImportPath}";`;

  const componentRef = isDefaultOnly ? componentName : "Component";

  const entryTsx = `
import React from "react";
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
    root.render(React.createElement(${componentRef}, props));
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
    root.render(React.createElement(${componentRef}, props));
  },
  getContainer() {
    return container;
  },
};

// Auto-mount with default props
(window as any).__120fps.mount({});
`;

  const indexHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>120fps harness</title></head>
<body><div id="root"></div><script type="module" src="./entry.tsx"></script></body>
</html>`;

  fs.writeFileSync(path.join(harnessDir, "entry.tsx"), entryTsx);
  fs.writeFileSync(path.join(harnessDir, "index.html"), indexHtml);

  // Resolve react from the component's project or from 120fps's own deps
  const componentDir = path.dirname(absoluteComponentPath);
  const projectRoot = findProjectRoot(componentDir) ?? componentDir;

  // Symlink node_modules into harness dir so Vite can resolve react/react-dom
  const projectNodeModules = path.join(projectRoot, "node_modules");
  const harnessNodeModules = path.join(harnessDir, "node_modules");
  if (fs.existsSync(projectNodeModules) && !fs.existsSync(harnessNodeModules)) {
    fs.symlinkSync(projectNodeModules, harnessNodeModules, "junction");
  }

  const server = await createServer({
    root: harnessDir,
    logLevel: "silent",
    server: {
      port: 0,
      strictPort: false,
      fs: { allow: [harnessDir, projectRoot, componentDir] },
    },
    resolve: {
      dedupe: ["react", "react-dom"],
    },
    optimizeDeps: {
      include: ["react", "react-dom/client"],
    },
  });

  await server.listen();

  const address = server.httpServer?.address();
  let url: string;
  if (address && typeof address === "object") {
    url = `http://localhost:${address.port}`;
  } else {
    throw new Error("Failed to start Vite dev server");
  }

  const cleanup = async () => {
    await server.close();
    fs.rmSync(harnessDir, { recursive: true, force: true });
  };

  return { url, server, cleanup };
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

function detectComponentExport(filePath: string): {
  name: string;
  isDefaultOnly: boolean;
} {
  const content = fs.readFileSync(filePath, "utf-8");

  // Check for named export: export function X / export const X
  const namedFnMatch = content.match(
    /export\s+function\s+([A-Z]\w*)/,
  );
  if (namedFnMatch) return { name: namedFnMatch[1], isDefaultOnly: false };

  const namedConstMatch = content.match(
    /export\s+const\s+([A-Z]\w*)\s*(?::[^=]+)?\s*=/,
  );
  if (namedConstMatch) return { name: namedConstMatch[1], isDefaultOnly: false };

  // Named class export: export class X extends ...
  const namedClassMatch = content.match(
    /export\s+class\s+([A-Z]\w*)/,
  );
  if (namedClassMatch) return { name: namedClassMatch[1], isDefaultOnly: false };

  // Check for default-only: export default function X / export default class X
  const defaultFnMatch = content.match(
    /export\s+default\s+function\s+([A-Z]\w*)/,
  );
  if (defaultFnMatch) return { name: defaultFnMatch[1], isDefaultOnly: true };

  const defaultConstMatch = content.match(
    /export\s+default\s+(?:const\s+)?([A-Z]\w*)/,
  );
  if (defaultConstMatch)
    return { name: defaultConstMatch[1], isDefaultOnly: true };

  // Fallback: derive from filename, assume default export
  const basename = path.basename(filePath, path.extname(filePath));
  const name = basename.charAt(0).toUpperCase() + basename.slice(1);
  return { name, isDefaultOnly: true };
}


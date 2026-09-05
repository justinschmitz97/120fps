import fs from "node:fs";
import path from "node:path";
import { createServer, searchForWorkspaceRoot, type ViteDevServer } from "vite";
import type { CompositionTree, ExportInfo } from "../props/index.js";
import {
  detectProjectTransforms,
  findProjectRoot,
  findWorkspaceRoot,
  isVueFile,
  loadProjectTransformPlugins,
  loadReactCompilerPlugin,
  loadVueCompiler,
  reactCompilerRuntimeDeps,
  reactJsxRuntimeDeps,
  resolveReactCompilerState,
  templateHasUnconditionalRoot,
  type ReactCompilerState,
} from "../project/index.js";
import { presentBundlerFailure } from "./bundler-failure.js";
import { cssImportHoistPlugin } from "./css-import-hoist.js";
import { relativeToRoot } from "./css.js";
import { createHarnessDir, forgetHarnessDirIfRemoved, sweepStaleHarnessDirs } from "./dirs.js";
import { readEnvDefines } from "./env.js";
import { generateComposedEntry, generateEntry } from "./entry.js";
import {
  detectComponentExport,
  detectScaleExport,
  resolveWrapper,
  sfcProducesComponent,
  SFC_NO_COMPONENT,
} from "./exports.js";
import { collectStaticPreBuildWarnings } from "./prebuild.js";
import {
  assertReactDomClient,
  assertRendererSupported,
  componentImportPath,
  jsxInJsPlugin,
  rendererFor,
  resolveJsxImportSource,
} from "./renderer.js";
import {
  closeServerBounded,
  fsAllowDirs,
  harnessServerCompileOptions,
  readDepCacheMetadata,
  unionCachedDeps,
  type ServerPool,
} from "./server.js";
import { loadPostcssConfigPipeline } from "./postcss-config.js";
import { probeInjectedStylesheets } from "./stylesheet-probe.js";
import {
  cssImportSpecifier,
  loadTailwind3PostcssPipeline,
  loadTailwindVitePlugin,
} from "./style-tooling.js";
import { toPosix } from "../shared/index.js";

export { findProjectRoot };

export interface ComponentIdentity {
  relative: string;
  name: string;
  isDefaultExport: boolean;
}

export interface HarnessResult {
  url: string;
  server: ViteDevServer;
  componentPath: string;
  harnessDir: string;
  cleanup: () => Promise<void>;
  component: ComponentIdentity;
  nextJsShims?: string[];
  wrapPath?: string;
  wrapRelative?: string;
  cssFiles?: string[];
  reactCompiler?: ReactCompilerState;
  // resolveReactDomIdentity reads this: an alias matching "react-dom" changes what mounts.
  viteAliases?: Array<{ find: RegExp; replacement: string }>;
  // Build-time advisories, e.g. a shared server whose frozen dep list misses this scan.
  warnings?: string[];
}

export function SWEEP_DEP_WARNING(missing: string[]): string {
  return (
    `shared sweep server was booted without ${missing.join(", ")} in its optimized deps; ` +
    "Vite discovers them on demand, which can reload the page once mid-run (retried automatically)"
  );
}

// Names the harness dir: the detail that turns "something failed" into something actionable.
export function VITE_START_FAILED(harnessDir: string, detail: string): string {
  return `Failed to start Vite dev server in ${harnessDir}: ${detail}`;
}

export interface BuildHarnessOptions {
  composition?: CompositionTree;
  exports?: ExportInfo[];
  noShims?: boolean;
  wrapPath?: string;
  cssFiles?: string[];
  reactCompiler?: boolean;
  // Reuse one dev server per config tuple across a sweep.
  serverPool?: ServerPool;
  // Imported by the entry so non-serializable preset values resolve in the page.
  presetPath?: string;
  // Measure what the harness can compile on its own.
  noTransforms?: boolean;
  // The export named by `<file>#Export`, instead of the one the selection order picks.
  target?: string;
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

  // Validated before the harness dir exists, so a rejected wrapper leaves nothing behind.
  const wrapRelative = options?.wrapPath
    ? resolveWrapper(options.wrapPath, projectRoot)
    : undefined;
  const reactCompiler = resolveReactCompilerState(projectRoot, options?.reactCompiler);
  // Only the resolution failure is a surprise worth printing; the disabled note is in the report.
  if (options?.reactCompiler !== false && reactCompiler.warning) {
    process.stderr.write(`Warning: ${reactCompiler.warning}\n`);
  }

  const renderer = rendererFor(absoluteComponentPath);
  // Computed ahead of entry generation, so a bare Vue mount wraps only a safe template root.
  let vueUnconditionalRoot = false;
  if (renderer === "vue") {
    const compiler = await loadVueCompiler(projectRoot);
    if (compiler) {
      const sfcs = [
        absoluteComponentPath,
        ...(options?.wrapPath ? [path.resolve(options.wrapPath)] : []),
      ];
      for (const sfc of sfcs) {
        if (!isVueFile(sfc)) continue;
        // An SFC compiling to no component would otherwise be a 30s readiness timeout.
        if (!sfcProducesComponent(fs.readFileSync(sfc, "utf-8"), sfc, compiler)) {
          throw new Error(SFC_NO_COMPONENT(toPosix(path.relative(projectRoot, sfc))));
        }
      }
      if (isVueFile(absoluteComponentPath)) {
        vueUnconditionalRoot = templateHasUnconditionalRoot(
          fs.readFileSync(absoluteComponentPath, "utf-8"),
          absoluteComponentPath,
          compiler,
        );
      }
    }
  }

  if (renderer === "react") {
    // The Vue-project question first: a Vue `.tsx` must not fail as a missing react-dom install.
    assertRendererSupported(absoluteComponentPath, projectRoot);
    assertReactDomClient(projectRoot);
  }

  // Crash leftovers from previous runs: best-effort removal.
  const sweepWarnings: string[] = [];
  sweepStaleHarnessDirs(projectRoot, sweepWarnings);

  // Placed inside the target project so Vite resolves the project's own aliases.
  const harnessDir = createHarnessDir(projectRoot);
  const harnessDirName = path.basename(harnessDir);

  const componentRelative = componentImportPath(absoluteComponentPath, projectRoot);

  const cssFiles = [...new Set((options?.cssFiles ?? []).map((f) => path.resolve(f)))];
  const cssImports = cssFiles.map((f) => cssImportSpecifier(f, projectRoot));

  const presetRelative = options?.presetPath
    ? toPosix(path.relative(projectRoot, path.resolve(options.presetPath)))
    : undefined;

  // Re-rendered when the stylesheet probe drops a sheet, before the page is ever requested.
  let renderEntry: (imports: string[]) => string;
  let component: ComponentIdentity;

  if (options?.composition) {
    const { composition, exports } = options;
    renderEntry = (imports) =>
      generateComposedEntry(componentRelative, composition, exports, wrapRelative, imports);
    const root = options.composition.root;
    component = {
      relative: componentRelative,
      name: root,
      isDefaultExport: options.exports?.some((e) => e.name === root && e.isDefault) ?? false,
    };
  } else {
    const { name: componentName, isDefaultOnly } = detectComponentExport(
      absoluteComponentPath,
      options?.target,
    );
    component = {
      relative: componentRelative,
      name: componentName,
      isDefaultExport: isDefaultOnly,
    };
    const hasScale = detectScaleExport(absoluteComponentPath);
    renderEntry = (imports) =>
      generateEntry({
        componentRelative,
        componentName,
        isDefaultExport: isDefaultOnly,
        hasScale,
        wrapRelative,
        cssImports: imports,
        renderer,
        ...(presetRelative ? { presetRelative } : {}),
        ...(renderer === "vue" ? { vueUnconditionalRoot } : {}),
      });
  }
  const entryTsx = renderEntry(cssImports);

  // The Vue entry has no JSX, so it is a .ts file and index.html has to name the one written.
  const entryFile = renderer === "vue" ? "entry.ts" : "entry.tsx";
  const indexHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>120fps harness</title></head>
<body><div id="root"></div><script type="module" src="./${entryFile}"></script></body>
</html>`;

  fs.writeFileSync(path.join(harnessDir, entryFile), entryTsx);
  fs.writeFileSync(path.join(harnessDir, "index.html"), indexHtml);

  // explainProps calls the same function, so both paths produce the same warnings in order.
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  const preBuild = collectStaticPreBuildWarnings(projectRoot, {
    componentPath: absoluteComponentPath,
    ...(options?.wrapPath ? { wrapPath: options.wrapPath } : {}),
    ...(options?.noShims ? { noShims: true } : {}),
    workspaceRoot,
  });
  const configWarnings: string[] = [...preBuild.warnings];
  const { viteConfig, externalDeps, styleTooling } = preBuild;
  const alias = preBuild.aliases;
  const activeShims = preBuild.nextModules.activeShims;

  // A Vue project has no react to pre-bundle, and an unresolvable include aborts server start.
  const rendererDeps =
    renderer === "vue"
      ? ["vue"]
      : [
          "react",
          "react-dom/client",
          ...reactJsxRuntimeDeps(projectRoot),
          ...(reactCompiler.active
            ? reactCompilerRuntimeDeps(projectRoot, reactCompiler.target ?? "19")
            : []),
        ];

  const stableInclude = unionCachedDeps(
    [...rendererDeps, ...externalDeps],
    readDepCacheMetadata(projectRoot),
  );

  const plugins: unknown[] = styleTooling.tailwind
    ? await loadTailwindVitePlugin(projectRoot)
    : [];
  // Ahead of Vite's own CSS plugin, so its import inliner sees the imports it accepts.
  plugins.push(cssImportHoistPlugin());
  // Rebuilding the member's declared pipeline takes the config decision away from the shell.
  const tailwind3Postcss =
    styleTooling.tailwind3ConfigPath && styleTooling.tailwind3PostcssConfigFile
      ? await loadTailwind3PostcssPipeline(
          projectRoot,
          styleTooling.tailwind3PostcssConfigFile,
          styleTooling.tailwind3ConfigPath,
          harnessDir,
          (warning) => configWarnings.push(warning),
        )
      : undefined;
  // `enforce: "pre"` alone decides ordering against Vite's own esbuild plugin, not position.
  plugins.push(
    jsxInJsPlugin(resolveJsxImportSource(projectRoot, workspaceRoot, absoluteComponentPath)),
  );
  const compileOptions = harnessServerCompileOptions(
    renderer,
    projectRoot,
    workspaceRoot,
    absoluteComponentPath,
    preBuild.resolveConditions,
  );
  // Appended, never substituted: the Tailwind entries above must survive.
  if (reactCompiler.active) {
    plugins.push(...(await loadReactCompilerPlugin(reactCompiler.pluginPath!, reactCompiler.target)));
  }

  // Resolved from the project's own node_modules with server hooks stripped.
  const transformWarnings: string[] = [];
  const transformEntries = options?.noTransforms
    ? []
    : detectProjectTransforms(projectRoot, workspaceRoot, (w) => transformWarnings.push(w));
  if (transformEntries.length > 0) {
    plugins.push(
      ...(await loadProjectTransformPlugins(projectRoot, transformEntries, (warning) =>
        transformWarnings.push(warning),
      )),
    );
  }

  const aliasAllow = fsAllowDirs(
    projectRoot,
    workspaceRoot,
    alias,
    // A component reached through /@fs/ needs its own directory named.
    componentRelative.startsWith("@fs/") ? [componentDir] : [],
  );
  // Widening never narrows, so Vite's own default root joins whenever the list exists at all.
  const fsAllow = aliasAllow && [...new Set([...aliasAllow, searchForWorkspaceRoot(projectRoot)])];

  // Without these the page has no `process`, and a component reading process.env throws.
  const define = readEnvDefines(projectRoot, workspaceRoot);

  // postcss-load-config accepts neither a string plugin name nor a [name, options] tuple, and it
  // resolves from the member instead of the package that declares the plugin, so the harness loads
  // the config itself and hands Vite the instances.
  const declaredPostcss =
    tailwind3Postcss === undefined && styleTooling.postcssConfigFile !== undefined
      ? await loadPostcssConfigPipeline(
          styleTooling.postcssConfigFile,
          projectRoot,
          workspaceRoot,
          (warning) => configWarnings.push(warning),
        )
      : undefined;

  // The rebuilt pipeline wins over the inherited config directory: same config, member's path.
  const postcssOption: string | { plugins: unknown[] } | undefined =
    tailwind3Postcss ?? declaredPostcss ?? styleTooling.postcssConfigDir;

  const bootServer = async (): Promise<ViteDevServer> => {
    const created = await createServer({
      root: projectRoot,
      // Not ours to run: its plugins target the project's own Vite major, not this container.
      configFile: false,
      logLevel: "silent",
      plugins: plugins as never,
      define,
      // The project's own static directory: its fonts 404 otherwise and text metrics go fallback.
      ...(viteConfig.publicDir ? { publicDir: viteConfig.publicDir } : {}),
      // One `css` object: passing postcss or preprocessorOptions alone drops the other.
      ...(postcssOption || viteConfig.preprocessorOptions
        ? {
            css: {
              ...(postcssOption ? { postcss: postcssOption as never } : {}),
              ...(viteConfig.preprocessorOptions
                ? { preprocessorOptions: viteConfig.preprocessorOptions }
                : {}),
            },
          }
        : {}),
      server: {
        port: 0,
        strictPort: false,
        // Overlay off: the client console.errors the full message, which page-error capture reads.
        hmr: { overlay: false },
        // Nothing edits files during a run; a watcher-triggered reload mid-run is a failure.
        watch: null,
        ...(fsAllow ? { fs: { allow: fsAllow } } : {}),
      },
      // The project's tsconfig `jsx` never decides how the harness compiles its own entry.
      ...(compileOptions.esbuild ? { esbuild: compileOptions.esbuild } : {}),
      resolve: {
        alias,
        dedupe: renderer === "vue" ? ["vue"] : ["react", "react-dom"],
        // A pass-through to Vite's own condition-aware exports resolver.
        ...(compileOptions.conditions ? { conditions: compileOptions.conditions } : {}),
      },
      optimizeDeps: {
        include: stableInclude,
      },
    });
    await created.listen();
    return created;
  };

  let server: ViteDevServer;
  let ownsServer = true;
  const buildWarnings: string[] = [
    ...transformWarnings,
    ...sweepWarnings,
    ...new Set(configWarnings),
  ];
  try {
    if (options?.serverPool) {
      // The tuple that shapes a server; anything else is per-component and lives in its dir.
      const poolKey = JSON.stringify([
        projectRoot,
        [...cssFiles].sort(),
        options?.wrapPath ? path.resolve(options.wrapPath) : null,
        reactCompiler.active,
        options?.noShims ?? false,
      ]);
      const acquired = await options.serverPool.acquire(poolKey, bootServer, stableInclude);
      server = acquired.server;
      ownsServer = false;
      if (acquired.reused) {
        const missing = stableInclude.filter((dep) => !acquired.include.has(dep));
        if (missing.length > 0) buildWarnings.push(SWEEP_DEP_WARNING(missing));
      }
    } else {
      server = await bootServer();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The dev server never started; presentBundlerFailure diagnoses the message shapes in turn.
    const detail = presentBundlerFailure(message, projectRoot, buildWarnings);
    // cleanup() is only constructed on the success path, so this catch must remove the dir.
    fs.rmSync(harnessDir, { recursive: true, force: true });
    forgetHarnessDirIfRemoved(harnessDir);
    // Warnings travel with the thrown error too, so a crash never silently drops one.
    throw Object.assign(new Error(VITE_START_FAILED(harnessDir, detail)), {
      cause: err,
      warnings: buildWarnings,
    });
  }

  // The entry imports the stylesheet first, so an uncompilable sheet stops the page before the
  // component evaluates. Compiling it here costs the transform the page would ask for anyway.
  let injectedCssFiles = cssFiles;
  if (cssImports.length > 0) {
    const probe = await probeInjectedStylesheets(
      server,
      cssImports.map((specifier, index) => ({
        specifier,
        label: relativeToRoot(cssFiles[index], projectRoot),
      })),
    );
    if (probe.kept.length < cssImports.length) {
      injectedCssFiles = cssFiles.filter((_, index) => probe.kept.includes(cssImports[index]));
      fs.writeFileSync(path.join(harnessDir, entryFile), renderEntry(probe.kept));
      buildWarnings.push(...probe.warnings);
    }
  }

  const address = server.httpServer?.address();
  let url: string;
  if (address && typeof address === "object") {
    url = `http://localhost:${address.port}/${harnessDirName}/`;
  } else {
    throw Object.assign(
      new Error(VITE_START_FAILED(harnessDir, "no listening address was returned")),
      { warnings: buildWarnings },
    );
  }

  const cleanup = async () => {
    if (ownsServer) await closeServerBounded(server);
    fs.rmSync(harnessDir, { recursive: true, force: true });
    forgetHarnessDirIfRemoved(harnessDir);
  };

  return {
    url,
    server,
    componentPath: absoluteComponentPath,
    harnessDir,
    cleanup,
    component,
    nextJsShims: activeShims,
    reactCompiler,
    ...(wrapRelative !== undefined
      ? { wrapPath: path.resolve(options!.wrapPath!), wrapRelative }
      : {}),
    ...(injectedCssFiles.length > 0 ? { cssFiles: injectedCssFiles } : {}),
    ...(viteConfig.aliases.length > 0 ? { viteAliases: viteConfig.aliases } : {}),
    ...(buildWarnings.length > 0 ? { warnings: buildWarnings } : {}),
  };
}

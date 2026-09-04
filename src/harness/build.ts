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
  // The project's own vite.config resolve.alias entries, already merged
  // into this harness's own alias list — so an alias that matches
  // "react-dom" genuinely changes what this server mounts, not just what a
  // manifest claims. resolveReactDomIdentity's second parameter reads this.
  viteAliases?: Array<{ find: RegExp; replacement: string }>;
  // Build-time advisories (e.g. a shared server whose frozen dep list
  // misses this component's scan). analyze() forwards them to the report.
  warnings?: string[];
}

export function SWEEP_DEP_WARNING(missing: string[]): string {
  return (
    `shared sweep server was booted without ${missing.join(", ")} in its optimized deps; ` +
    "Vite discovers them on demand, which can reload the page once mid-run (retried automatically)"
  );
}

// Names both the cause (whatever Vite or the address check reported) and
// where: the one detail that turns "something failed" into something a user
// can act on (check the harness dir, or the underlying message, for why).
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
  // Absolute path to a `<stem>.props.tsx` preset module, imported by the
  // entry so non-serializable preset values resolve in the page.
  presetPath?: string;
  // Skip the project's own Vite transforms (measure what the harness can
  // compile on its own).
  noTransforms?: boolean;
  // The export named by `<file>#Export`, imported instead of the one the
  // selection order would pick.
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

  // Validate before creating the harness dir so a rejected wrapper or an
  // unresolvable forced compiler leaves nothing behind
  const wrapRelative = options?.wrapPath
    ? resolveWrapper(options.wrapPath, projectRoot)
    : undefined;
  const reactCompiler = resolveReactCompilerState(projectRoot, options?.reactCompiler);
  // Only the resolution failure is a surprise worth printing; the disabled note
  // is a consequence of the user's own flag and travels in the report.
  if (options?.reactCompiler !== false && reactCompiler.warning) {
    process.stderr.write(`Warning: ${reactCompiler.warning}\n`);
  }

  // An SFC that compiles to no component would otherwise surface as a 30s
  // readiness timeout with a module-resolution message attached, naming the
  // harness instead of the file to fix. Checked here so nothing is left behind.
  const renderer = rendererFor(absoluteComponentPath);
  // Computed once, ahead of entry generation, so a bare (non-composed)
  // Vue mount can wrap its render only when the template root is safe to
  // force non-zero -- see templateHasUnconditionalRoot.
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

  // react-dom/client is forced into optimizeDeps.include below, and an
  // unresolvable include aborts Vite's optimizer with an esbuild path dump.
  if (renderer === "react") {
    // I2: the Vue-project question first — otherwise a Vue `.tsx` fails as a
    // missing react-dom install, which is not why it cannot be measured.
    assertRendererSupported(absoluteComponentPath, projectRoot);
    assertReactDomClient(projectRoot);
  }

  // Crash leftovers from previous runs: best-effort removal.
  const sweepWarnings: string[] = [];
  sweepStaleHarnessDirs(projectRoot, sweepWarnings);

  // Place harness files inside the target project so Vite resolves aliases
  // (createHarnessDir adds it to activeHarnessDirs itself).
  const harnessDir = createHarnessDir(projectRoot);
  const harnessDirName = path.basename(harnessDir);

  const componentRelative = componentImportPath(absoluteComponentPath, projectRoot);

  const cssFiles = [...new Set((options?.cssFiles ?? []).map((f) => path.resolve(f)))];
  const cssImports = cssFiles.map((f) => cssImportSpecifier(f, projectRoot));

  const presetRelative = options?.presetPath
    ? toPosix(path.relative(projectRoot, path.resolve(options.presetPath)))
    : undefined;

  let entryTsx: string;
  let component: ComponentIdentity;

  if (options?.composition) {
    entryTsx = generateComposedEntry(
      componentRelative,
      options.composition,
      options.exports,
      wrapRelative,
      cssImports,
    );
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
    entryTsx = generateEntry({
      componentRelative,
      componentName,
      isDefaultExport: isDefaultOnly,
      hasScale: detectScaleExport(absoluteComponentPath),
      wrapRelative,
      cssImports,
      renderer,
      ...(presetRelative ? { presetRelative } : {}),
      ...(renderer === "vue" ? { vueUnconditionalRoot } : {}),
    });
  }

  // The Vue entry has no JSX, so it is a .ts file: and index.html has to name
  // whichever one was written.
  const entryFile = renderer === "vue" ? "entry.ts" : "entry.tsx";
  const indexHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>120fps harness</title></head>
<body><div id="root"></div><script type="module" src="./${entryFile}"></script></body>
</html>`;

  fs.writeFileSync(path.join(harnessDir, entryFile), entryTsx);
  fs.writeFileSync(path.join(harnessDir, "index.html"), indexHtml);

  // The single computation of every pre-build fact this run needs.
  // `explainProps` calls the same function for a dry run, so both paths
  // produce the same warnings in the same order.
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

  // A Vue project has no react to pre-bundle, and an unresolvable include
  // aborts server start: so the renderer decides the base list, not a union.
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
  // Tailwind 3 enters through PostCSS and resolves its own
  // config against `process.cwd()`, so the shell directory decided whether the
  // member's CSS built at all. Rebuilding the member's declared pipeline with
  // the config path resolved from the member takes that decision away from the
  // shell without replacing a single plugin the member declared.
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
  // Unconditional and cheap (a no-op for every file outside a
  // non-node_modules `.js`); array position does not matter for ordering
  // relative to Vite's own esbuild plugin, since `enforce: "pre"` alone
  // decides that.
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

  // The project's own transforms, resolved from its own node_modules with
  // server hooks stripped. Load failure warns and continues.
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

  // Vite refuses to serve a file outside its allow list. Undefined for a
  // project whose alias targets are all inside its own root, which keeps
  // Vite's defaults everywhere they already worked.
  // Vite's own default is the one root it searches for; widening never narrows
  // it, so its answer joins the list whenever the list exists at all.
  // Vite serves nothing outside its allow list, so a component reached
  // through /@fs/ needs its own directory named.
  const aliasAllow = fsAllowDirs(
    projectRoot,
    workspaceRoot,
    alias,
    componentRelative.startsWith("@fs/") ? [componentDir] : [],
  );
  const fsAllow = aliasAllow && [...new Set([...aliasAllow, searchForWorkspaceRoot(projectRoot)])];

  // Without these the page has no `process` at all, and a component
  // reading process.env throws before it renders.
  const define = readEnvDefines(projectRoot, workspaceRoot);

  // The rebuilt Tailwind 3 pipeline wins over the inherited config directory:
  // it is that directory's config, already loaded, with the config path the
  // member's own search would have found.
  const postcssOption: string | { plugins: unknown[] } | undefined =
    tailwind3Postcss ?? styleTooling.postcssConfigDir;

  const bootServer = async (): Promise<ViteDevServer> => {
    const created = await createServer({
      root: projectRoot,
      // The project's vite.config is not ours to run: its plugins target the
      // project's own Vite major (a rolldown plugin-react in a Vite 6 container
      // fails every transform), and its server options are not measurement-safe.
      // Aliases and the plugins we do need are reconstructed above by hand.
      configFile: false,
      logLevel: "silent",
      plugins: plugins as never,
      define,
      // The project's own static directory, recovered from the config text: its
      // fonts 404 otherwise and every text metric becomes a fallback-font one.
      ...(viteConfig.publicDir ? { publicDir: viteConfig.publicDir } : {}),
      // Vite searches from its root up to its own idea of the workspace root,
      // which a lockfile-only monorepo root does not satisfy; naming the
      // directory is a no-op wherever its own walk already reaches.
      // postcss and the folded preprocessor options share one `css`
      // object — twenty declares both, and passing either alone dropped the
      // other.
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
        // With the overlay on, Vite renders transform failures into a DOM element
        // and logs nothing; with it off the client console.errors the full
        // message, which the page-error capture turns into a usable diagnosis.
        hmr: { overlay: false },
        // Nothing edits files during a measurement run, so file watching is
        // pure cost: chokidar's initial scan of a real repo (a Next.js .next/
        // dir has thousands of files) saturates the fs threadpool exactly when
        // the first module loads, and a watcher-triggered reload mid-measurement
        // is the failure the context retry in browser/retry.ts exists for.
        watch: null,
        ...(fsAllow ? { fs: { allow: fsAllow } } : {}),
      },
      // What the project's tsconfig says about `jsx` never decides
      // how the harness compiles its .ts/.tsx/.jsx. Resolve
      // conditions carry the governing tsconfig's customConditions.
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
      // The tuple that shapes a server; anything else is per-component and
      // lives in the harness dir, not the server.
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
    // Surface 1 of the shared pipeline (presentBundlerFailure) -- the
    // dev server itself never started. Vite/esbuild's message blaming a
    // workspace-internal package's package.json fields when
    // the real problem is that the package was never built is the first
    // diagnoser this chain tries; every other shape falls through in turn,
    // stripBundlerStackFrames as the universal last resort.
    const detail = presentBundlerFailure(message, projectRoot, buildWarnings);
    // The common, caught-and-rethrown failure shape. cleanup() is only ever
    // constructed on the success path, so this catch is the one place the
    // directory would otherwise leak on every one of these.
    fs.rmSync(harnessDir, { recursive: true, force: true });
    forgetHarnessDirIfRemoved(harnessDir);
    // Everything buildWarnings would have carried on the success
    // path travels with the thrown error too, so a crash after a computed
    // warning (VITE_CONFIG_IGNORED_WARNING, an unreplicated style engine, a
    // transform-load failure) does not silently drop it.
    throw Object.assign(new Error(VITE_START_FAILED(harnessDir, detail)), {
      cause: err,
      warnings: buildWarnings,
    });
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
    ...(cssFiles.length > 0 ? { cssFiles } : {}),
    ...(viteConfig.aliases.length > 0 ? { viteAliases: viteConfig.aliases } : {}),
    ...(buildWarnings.length > 0 ? { warnings: buildWarnings } : {}),
  };
}

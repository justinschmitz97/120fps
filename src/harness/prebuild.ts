import path from "node:path";
import {
  findWorkspaceRoot,
  loadTsconfigAliases,
  resolveServerConditions,
  type WorkspaceRootAliasSource,
} from "../project/index.js";
import { scanExternalDeps } from "./deps-scan.js";
import {
  SHIM_MODULES,
  UNSUPPORTED_NEXT_MODULE_WARNING,
  buildShimAliases,
  detectNextJs,
  unshimmedNextModules,
} from "./shims.js";
import { type StyleTooling, resolveStyleTooling } from "./style-tooling.js";
import {
  VITE_CONFIG_IGNORED_WARNING,
  type ViteConfigData,
  readViteConfigData,
} from "./vite-config.js";

// M100 (I5): every pre-build fact `buildAndServe` derives from the filesystem
// alone — no bundler, no dev server, no browser. `--explain-props` refused to
// start a server and therefore never saw any of it (V6's rows 5, 17-21), so a
// dry run was silent about a broken vite.config alias, an unbuilt workspace
// dist/, a type-only package, an unsupported Next module and a missing style
// engine, all of which the real run reported seconds later.
export interface StaticPreBuild {
  warnings: string[];
  viteConfig: ViteConfigData;
  // M109 (A5): the conditions the dev server resolves exports under — the vite
  // config's own list, then the governing tsconfig's customConditions.
  resolveConditions: string[];
  externalDeps: string[];
  styleTooling: StyleTooling;
  nextModules: { detected: boolean; activeShims?: string[]; unsupported: string[] };
  // Consumed by buildAndServe, which must not rebuild them: `scanExternalDeps`
  // appends its workspace-source rescue aliases (M94) to this same array.
  aliases: Array<{
    find: RegExp;
    replacement: string;
    isShim?: boolean;
    fromWorkspaceRoot?: WorkspaceRootAliasSource;
  }>;
  importedSpecifiers: Set<string>;
  // M110 (A2/I2, epic-stack-F2): every specifier the scan could not resolve to
  // a package, an alias or an `imports` entry, so both modes report the same
  // set without walking the graph again.
  unresolvedExternals: Array<{ specifier: string; importer: string }>;
  workspaceRoot: string;
}


// The pre-build half of `buildAndServe`, in call order, with nothing that
// starts a process: `loadTsconfigAliases`, `readViteConfigData` (text-parsed,
// never imported), `scanExternalDeps` (path probes), the Next shim inventory
// and `resolveStyleTooling` (dependency probes). Warnings come back in exactly
// the order `buildAndServe` produced them, and no message is reworded.
export function collectStaticPreBuildWarnings(
  projectRoot: string,
  opts: {
    componentPath: string;
    wrapPath?: string;
    noShims?: boolean;
    workspaceRoot?: string;
  },
): StaticPreBuild {
  const workspaceRoot = opts.workspaceRoot ?? findWorkspaceRoot(projectRoot);
  // M69: alias construction and the scan both report what they could not
  // resolve, and both feed the same run warnings.
  const warnings: string[] = [];
  const tsconfigAliases = loadTsconfigAliases(projectRoot, warnings, opts.componentPath);
  const detected = !opts.noShims && detectNextJs(projectRoot);
  const shimAliases = buildShimAliases(detected);
  // M71: what the project's own vite.config says, read as text. Its aliases sit
  // below the tsconfig paths, which is the precedence a TypeScript project
  // already assumes, and above the shims, which answer for one module each.
  const viteConfig = readViteConfigData(projectRoot, workspaceRoot);
  if (viteConfig.configFile && viteConfig.ignoredKeys.length > 0) {
    warnings.push(
      VITE_CONFIG_IGNORED_WARNING(
        path.basename(viteConfig.configFile),
        viteConfig.ignoredKeys,
        viteConfig.pluginNames,
      ),
    );
  }
  warnings.push(...viteConfig.warnings);
  // M109 (A5): decided here, so the dry run discloses the list the real run
  // resolves with.
  const serverConditions = resolveServerConditions(projectRoot, viteConfig.conditions, {
    forFile: opts.componentPath,
    workspaceRoot,
    ...(viteConfig.configFile ? { viteConfigFile: viteConfig.configFile } : {}),
  });
  if (serverConditions.warning) warnings.push(serverConditions.warning);
  const aliases: StaticPreBuild["aliases"] = [
    ...tsconfigAliases,
    ...viteConfig.aliases,
    ...shimAliases,
  ];

  // The wrapper is imported by the entry, so its packages must be pre-bundled
  // too: otherwise the first mount pays Vite's on-demand optimize cost.
  const importedSpecifiers = new Set<string>();
  // M110 (A2/I2): filled by the same walk that produces the include list, so
  // the dry run reports what the real run's optimizer would have choked on.
  const unresolvedExternals: Array<{ specifier: string; importer: string }> = [];
  const reportedUnresolvedSpecifiers = new Set<string>();
  const externalDeps = [
    ...new Set([
      ...scanExternalDeps(
        path.resolve(opts.componentPath),
        projectRoot,
        aliases,
        importedSpecifiers,
        warnings,
        workspaceRoot,
        aliases,
        unresolvedExternals,
        reportedUnresolvedSpecifiers,
      ),
      ...(opts.wrapPath
        ? scanExternalDeps(
            path.resolve(opts.wrapPath),
            projectRoot,
            aliases,
            importedSpecifiers,
            warnings,
            workspaceRoot,
            aliases,
            unresolvedExternals,
            reportedUnresolvedSpecifiers,
          )
        : []),
    ]),
  ];

  // Shims are keyed by module specifier ("next/image"), which scanExternalDeps
  // collapses to a package name ("next") for optimizeDeps: match on the raw
  // specifiers instead.
  let activeShims: string[] | undefined;
  let unsupported: string[] = [];
  if (detected) {
    const shimmed = SHIM_MODULES.filter((s) => importedSpecifiers.has(s.module)).map(
      (s) => s.module,
    );
    activeShims = shimmed.length > 0 ? shimmed : undefined;
    unsupported = unshimmedNextModules(importedSpecifiers);
    if (unsupported.length > 0) warnings.push(UNSUPPORTED_NEXT_MODULE_WARNING(unsupported));
  }

  // M71: the Tailwind plugin is decided by the project's dependency alone. A
  // component using utility classes needs it whether or not a global stylesheet
  // was found, and the styling engines nothing here can replicate say so once.
  const styleTooling = resolveStyleTooling(projectRoot, workspaceRoot, externalDeps);
  warnings.push(...styleTooling.warnings);

  return {
    warnings,
    viteConfig,
    resolveConditions: serverConditions.conditions,
    externalDeps,
    styleTooling,
    nextModules: { detected, ...(activeShims ? { activeShims } : {}), unsupported },
    aliases,
    importedSpecifiers,
    unresolvedExternals,
    workspaceRoot,
  };
}

import path from "node:path";
import { pathKey } from "../shared/index.js";
import {
  findWorkspaceRoot,
  loadTsconfigAliases,
  resolveServerConditions,
  tsconfigAliasesForFile,
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

// Filesystem-only facts, so --explain-props reports without a bundler, server or browser.
export interface StaticPreBuild {
  warnings: string[];
  viteConfig: ViteConfigData;
  // The vite config's own list, then the governing tsconfig's customConditions.
  resolveConditions: string[];
  externalDeps: string[];
  styleTooling: StyleTooling;
  nextModules: { detected: boolean; activeShims?: string[]; unsupported: string[] };
  // scanExternalDeps appends its workspace-source rescue aliases to this same array.
  aliases: Array<{
    find: RegExp;
    replacement: string;
    isShim?: boolean;
    fromWorkspaceRoot?: WorkspaceRootAliasSource;
  }>;
  importedSpecifiers: Set<string>;
  // Both modes report the same set without walking the graph again.
  unresolvedExternals: Array<{ specifier: string; importer: string }>;
  workspaceRoot: string;
}


// One --explain-props invocation walks several candidates over one graph; a specifier that
// resolves nowhere is one fact about the project, not one per candidate. The candidate that met
// it first keeps it, so the dry run and the real run of one component still report identically.
const disclosedUnresolvedByProject = new Map<string, Map<string, string>>();

// The vite config is a fact about the project, so a per-candidate walk states it once per run.
const disclosedViteConfigNotes = new Set<string>();

export function resetPreBuildDisclosures(): void {
  disclosedUnresolvedByProject.clear();
  disclosedViteConfigNotes.clear();
}


// Warnings come back in buildAndServe's own order, with no message reworded.
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
  const warnings: string[] = [];
  const tsconfigAliases = loadTsconfigAliases(projectRoot, warnings, opts.componentPath);
  const detected = !opts.noShims && detectNextJs(projectRoot);
  const shimAliases = buildShimAliases(detected);
  // Read as text; the project's vite.config is never imported.
  const viteConfig = readViteConfigData(projectRoot, workspaceRoot);
  if (
    viteConfig.configFile &&
    viteConfig.ignoredKeys.length > 0 &&
    !disclosedViteConfigNotes.has(viteConfig.configFile)
  ) {
    disclosedViteConfigNotes.add(viteConfig.configFile);
    warnings.push(
      VITE_CONFIG_IGNORED_WARNING(
        path.basename(viteConfig.configFile),
        viteConfig.ignoredKeys,
        viteConfig.pluginNames,
      ),
    );
  }
  warnings.push(...viteConfig.warnings);
  // Decided here, so the dry run discloses the list the real run resolves with.
  const serverConditions = resolveServerConditions(projectRoot, viteConfig.conditions, {
    forFile: opts.componentPath,
    workspaceRoot,
    ...(viteConfig.configFile ? { viteConfigFile: viteConfig.configFile } : {}),
  });
  if (serverConditions.warning) warnings.push(serverConditions.warning);
  // Vite aliases sit below tsconfig paths, the precedence a TypeScript project assumes.
  const aliases: StaticPreBuild["aliases"] = [
    ...tsconfigAliases,
    ...viteConfig.aliases,
    ...shimAliases,
  ];
  // Only the tsconfig layer is per-package; vite aliases, shims and rescues are project-wide.
  // The swap keeps that layer where it sits, so a rescue the walk put ahead of it stays ahead.
  const measuredTsconfigAliases = new Set(tsconfigAliases);
  const aliasesForFile = (file: string): StaticPreBuild["aliases"] => {
    const governing = tsconfigAliasesForFile(projectRoot, file);
    if (governing === tsconfigAliases) return aliases;
    const swapped: StaticPreBuild["aliases"] = [];
    let placed = false;
    for (const alias of aliases) {
      if (measuredTsconfigAliases.has(alias)) {
        if (!placed) {
          swapped.push(...governing);
          placed = true;
        }
        continue;
      }
      swapped.push(alias);
    }
    if (!placed) swapped.push(...governing);
    return swapped;
  };

  const importedSpecifiers = new Set<string>();
  // Filled by the same walk, so the dry run reports what the real optimizer would choke on.
  const unresolvedExternals: Array<{ specifier: string; importer: string }> = [];
  const projectDisclosureKey = pathKey(projectRoot);
  const disclosureOwners =
    disclosedUnresolvedByProject.get(projectDisclosureKey) ?? new Map<string, string>();
  disclosedUnresolvedByProject.set(projectDisclosureKey, disclosureOwners);
  const componentDisclosureKey = pathKey(opts.componentPath);
  const reportedUnresolvedSpecifiers = new Set<string>();
  for (const [specifier, owner] of disclosureOwners) {
    if (owner !== componentDisclosureKey) reportedUnresolvedSpecifiers.add(specifier);
  }
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
        aliasesForFile,
      ),
      // Wrapper packages must be pre-bundled too, or the first mount pays the optimize cost.
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
            aliasesForFile,
          )
        : []),
    ]),
  ];

  // The scan collapses "next/image" to "next", so match shims on the raw specifiers.
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

  for (const specifier of reportedUnresolvedSpecifiers) {
    if (!disclosureOwners.has(specifier)) disclosureOwners.set(specifier, componentDisclosureKey);
  }

  // Decided by the dependency alone: utility classes need it with no global stylesheet.
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

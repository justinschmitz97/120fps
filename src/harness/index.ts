export * from "./build.js";
export * from "./bundler-failure.js";
export * from "./css.js";
export * from "./deps-scan.js";
export * from "./dirs.js";
export * from "./entry.js";
export * from "./env.js";
export * from "./exports.js";
export * from "./prebuild.js";
export * from "./renderer.js";
export * from "./server.js";
export * from "./shims.js";
export * from "./stylesheets.js";
export * from "./style-tooling.js";
export * from "./vite-config.js";
export * from "./workspace-entries.js";
// Project-stage declarations the harness surface still names: tsconfig aliases,
// the React Compiler resolution, transform plugins and module resolution are
// project facts, and callers reach them through the stage that reads them.
export {
  ALIAS_SHAPE_WARNING,
  detectProjectTransforms,
  detectReactCompiler,
  detectReactMajor,
  HOISTED_TRANSFORM_WARNING,
  loadReactCompilerPlugin,
  loadTsconfigAliases,
  reactCompilerBabelOptions,
  reactCompilerResolutionWarning,
  reactCompilerRuntimeDeps,
  reactJsxRuntimeDeps,
  REACT_COMPILER_DISABLED_WARNING,
  REACT_COMPILER_PACKAGE,
  resetGoverningDisclosures,
  resolveReactCompiler,
  resolveReactCompilerState,
  resolveServerConditions,
  ROOT_ABSOLUTE_ALIAS_WARNING,
  stripServerHooks,
  SUPPORTED_TRANSFORM_PLUGINS,
  TSCONFIG_EXTENDS_BROKEN_WARNING,
  TYPES_ONLY_ALIAS_WARNING,
  type ReactCompilerResolution,
  type ReactCompilerState,
} from "../project/index.js";

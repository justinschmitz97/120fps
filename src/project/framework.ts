import {
  declaredPackages,
  findWorkspaceRoot,
  isPackageAvailable,
  isPackageDeclared,
  readProjectManifest,
} from "./model.js";

export const FRAMEWORK_MANIFEST_UNREADABLE = (root: string): string =>
  `no readable package.json in ${root}, so the component is measured as vanilla; ` +
  `pass --framework react|vue to say what it is.`;

// M72: a project that also ships solid-js is not rejected — mixed repos
// exist and the React tree is still measurable — but a Solid component
// inside it will fail to mount, so the run says so up front.
export const SOLID_AND_REACT_DECLARED = (root: string): string =>
  `${root} declares both react and solid-js; 120fps only measures the React tree, so a Solid ` +
  "component here will fail to mount.";

// M74 (D6): a project that declares preact but neither react nor vue used to
// resolve "vanilla" in total silence, skipping every React-family analysis
// pass (memo bailout, context fan-out, callback identity, render
// attribution) with no signal that anything was skipped.
export const PREACT_UNSUPPORTED_WARNING = (root: string): string =>
  `${root} declares preact but no react or vue; Preact-specific analysis is not supported, so ` +
  "the run proceeds framework-agnostic (measured as vanilla).";

// React wins a tie: a project with both installed is a React project that also
// ships some Vue, and the React optimization pass is the one with findings.
function frameworkFrom(names: Set<string>): "react" | "vue" | undefined {
  if (names.has("react") || names.has("react-dom")) return "react";
  if (names.has("vue")) return "vue";
  return undefined;
}

// M68. The member's own manifest decides whenever it names a framework: a Vue
// package inside a React monorepo is a Vue package. Only a member that names
// none falls back to the workspace root and then to what is installed.
// An unreadable manifest is evidence of nothing, so it fails closed to vanilla:
// the old `react` default mounted non-React code as React.
// A `.vue` file overrides all of it: see analyze's resolveFramework.
export function detectFramework(
  memberRoot: string,
  onWarning?: (warning: string) => void,
): "react" | "vue" | "vanilla" {
  if (!readProjectManifest(memberRoot)) {
    onWarning?.(FRAMEWORK_MANIFEST_UNREADABLE(memberRoot));
    return "vanilla";
  }
  const workspaceRoot = findWorkspaceRoot(memberRoot);
  const own = frameworkFrom(declaredPackages(memberRoot));
  const shared = own ? undefined : frameworkFrom(declaredPackages(workspaceRoot));
  let resolved: "react" | "vue" | "vanilla" | undefined = own ?? shared;
  if (!resolved) {
    if (
      isPackageAvailable("react", memberRoot, workspaceRoot) ||
      isPackageAvailable("react-dom", memberRoot, workspaceRoot)
    ) {
      resolved = "react";
    } else {
      resolved = isPackageAvailable("vue", memberRoot, workspaceRoot) ? "vue" : "vanilla";
    }
  }
  // M72: solid-js alongside react is not rejected here (see runPreflight for
  // the solid-only rejection); it only warns. Declared, not merely available
  // (M75 widened isPackageAvailable to walk ancestor node_modules): the
  // message asserts the project "declares" solid-js, which must stay true, so
  // a transitive, hoisted-but-undeclared solid-js must not trigger it.
  if (resolved === "react" && isPackageDeclared("solid-js", memberRoot, workspaceRoot)) {
    onWarning?.(SOLID_AND_REACT_DECLARED(memberRoot));
  }
  // M74 (D6): vanilla is a real resolution when nothing is declared or
  // installed at all, but a project that declares preact and stops there
  // deserves to know its React-family analysis is being skipped.
  if (resolved === "vanilla" && isPackageDeclared("preact", memberRoot, workspaceRoot)) {
    onWarning?.(PREACT_UNSUPPORTED_WARNING(memberRoot));
  }
  return resolved;
}

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

// Mixed repos are measurable, so a declared solid-js warns instead of rejecting.
export const SOLID_AND_REACT_DECLARED = (root: string): string =>
  `${root} declares both react and solid-js; 120fps only measures the React tree, so a Solid ` +
  "component here will fail to mount.";

// A preact project resolves vanilla, which silently skips every React-family analysis pass.
export const PREACT_UNSUPPORTED_WARNING = (root: string): string =>
  `${root} declares preact but no react or vue; Preact-specific analysis is not supported, so ` +
  "the run proceeds framework-agnostic (measured as vanilla).";

// React wins a tie: its optimization pass is the one with findings.
function frameworkFrom(names: Set<string>): "react" | "vue" | undefined {
  if (names.has("react") || names.has("react-dom")) return "react";
  if (names.has("vue")) return "vue";
  return undefined;
}

// The member's own manifest wins; pipeline/resolve.ts's resolveFramework overrides for .vue.
export function detectFramework(
  memberRoot: string,
  onWarning?: (warning: string) => void,
): "react" | "vue" | "vanilla" {
  // Fails closed: defaulting to react would mount non-React code as React.
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
  // Declared, not available: the message asserts "declares", so a hoisted copy must not fire.
  if (resolved === "react" && isPackageDeclared("solid-js", memberRoot, workspaceRoot)) {
    onWarning?.(SOLID_AND_REACT_DECLARED(memberRoot));
  }
  if (resolved === "vanilla" && isPackageDeclared("preact", memberRoot, workspaceRoot)) {
    onWarning?.(PREACT_UNSUPPORTED_WARNING(memberRoot));
  }
  return resolved;
}

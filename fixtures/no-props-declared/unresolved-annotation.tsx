import type { GhostProps } from "./ghost-types-that-are-not-on-disk";

// The props type names a module that resolves to no file, so an empty table is a failure.
export function Ghost(props: GhostProps) {
  return <div>{String(props)}</div>;
}

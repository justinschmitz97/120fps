import { readFlag } from "./lib/env";

export function ReachesNodeBuiltin() {
  return <div>{String(readFlag())}</div>;
}

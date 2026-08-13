import { loadRows } from "./lib/data";

export function ReachesServerOnly() {
  return <div>{loadRows().length}</div>;
}

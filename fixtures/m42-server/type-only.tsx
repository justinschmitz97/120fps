import type { Row } from "./lib/data";

export function TypeOnly({ row }: { row?: Row }) {
  return <div>{row?.id ?? "none"}</div>;
}

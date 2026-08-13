interface Point {
  x: number;
  y: number;
}

export interface ArrayEdgesProps {
  frozen: readonly string[];
  pair: [number, number];
  mixed: (string | number)[];
  grid: Point[][];
  loose: unknown[];
  maybe?: Point[];
  flags: boolean[];
  literals: ("a" | "b")[];
  empty: Record<string, never>[];
}

export function ArrayEdges({ frozen }: ArrayEdgesProps) {
  return <div>{frozen.join(",")}</div>;
}

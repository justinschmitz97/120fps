interface Row {
  id: number;
  label: string;
}

type Line = { kind: "plain"; text: string } | { kind: "marked"; text: string; hits: number };

interface TreeNode {
  label: string;
  child: TreeNode;
}

export interface TypedArraysProps {
  rows: Row[];
  lines: Line[];
  tags: string[];
  counts: number[];
  handlers: ((value: string) => void)[];
  nodes: TreeNode[];
}

export function TypedArrays({ rows, lines, tags }: TypedArraysProps) {
  return (
    <div>
      {rows.map((r) => (
        <span key={r.id}>{r.label}</span>
      ))}
      {lines.map((l, i) => (
        <p key={i}>{l.text}</p>
      ))}
      {tags.map((t) => (
        <b key={t}>{t}</b>
      ))}
    </div>
  );
}

import React from "react";

interface Cell {
  id: string;
  value: number;
  filled: boolean;
}

interface Board {
  name: string;
  rows: number;
  cells: Cell[];
  meta: { author: string; version: number };
}

interface MinimizeOptions {
  removeComments: boolean;
  collapseWhitespace: boolean;
  sortAttributes: boolean;
  minifyCss: boolean;
  minifyJs: boolean;
}

interface GraphProps {
  board: Board;
  options?: MinimizeOptions;
  label: string;
}

export function GraphView({ board, options, label }: GraphProps) {
  return (
    <section aria-label={label}>
      <h2>{board.name}</h2>
      <p>{board.meta.author}</p>
      <ul>
        {board.cells.map((cell) => (
          <li key={cell.id}>{cell.value}</li>
        ))}
      </ul>
      <span>{options?.removeComments ? "min" : "raw"}</span>
    </section>
  );
}

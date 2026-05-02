import React from "react";

interface Column<T> {
  key: keyof T;
  label: string;
}

interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  striped?: boolean;
  pageSize?: number;
}

export function DataTable<T extends Record<string, unknown>>({
  data,
  columns,
  striped = false,
  pageSize = 10,
}: DataTableProps<T>) {
  return (
    <table className={striped ? "striped" : ""}>
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={String(col.key)}>{col.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.slice(0, pageSize).map((row, i) => (
          <tr key={i}>
            {columns.map((col) => (
              <td key={String(col.key)}>{String(row[col.key])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

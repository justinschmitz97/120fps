import React from "react";

export interface MetadataProps {
  title: string;
  data: Record<string, unknown>;
  showEmpty?: boolean;
}

export function Metadata({ title, data, showEmpty = false }: MetadataProps) {
  const entries = Object.entries(data).filter(
    ([, v]) => showEmpty || v != null,
  );
  return (
    <div>
      <h3>{title}</h3>
      <dl>
        {entries.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt>{k}</dt>
            <dd>{String(v)}</dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  );
}

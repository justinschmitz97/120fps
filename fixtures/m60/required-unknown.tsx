import React from "react";

interface TokenProps {
  // Required and unenumerable: the component is handed `undefined`.
  token: string | number;
  label: string;
}

export function TokenBadge({ token, label }: TokenProps) {
  return <span title={label}>{String(token)}</span>;
}

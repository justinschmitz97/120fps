import React from "react";

interface MixedProps {
  label: string;
  // Neither a literal union nor a single primitive: classification has nothing
  // finite to enumerate, so the value pool is empty.
  value?: string | number;
  span?: bigint;
}

export function OptionalUnknown({ label, value, span }: MixedProps) {
  return (
    <div data-span={String(span)}>
      {label}: {String(value)}
    </div>
  );
}

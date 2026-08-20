import React from "react";

// Positive control (M81 section 1): `variant` is reached through an indexed
// access on a locally re-declared type, so it is `declaredHere: true` under
// both the old two-bucket partition and the new tier rank. Must stay
// unaffected by the rank change.
export interface TableVariants {
  variant: "default" | "striped" | "bordered";
}

export interface TableProps {
  variant?: TableVariants["variant"];
  rows: unknown[];
}

export function Table({ variant, rows }: TableProps) {
  return <table data-variant={variant} data-rows={rows.length} />;
}

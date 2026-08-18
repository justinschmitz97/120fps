import React from "react";

interface HelperProps {
  a: string;
  b: number;
}

function Helper({ a, b }: HelperProps) {
  return <em>{a}{b}</em>;
}

interface CoreProps {
  title: string;
  rows: number[];
}

function Core({ title, rows }: CoreProps) {
  return <div>{title}{rows.length}</div>;
}

// The file is named after the *exported* alias, not the local declaration.
export { Helper, Core as AliasWidget };

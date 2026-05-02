import React from "react";

// Import a package that exists in our node_modules
// Using a type-only import to avoid runtime dep issues
interface DepTestProps {
  label: string;
  active?: boolean;
}

export function DepTest({ label, active = false }: DepTestProps) {
  const className = active ? "active" : "inactive";
  return <div className={className}>{label}</div>;
}

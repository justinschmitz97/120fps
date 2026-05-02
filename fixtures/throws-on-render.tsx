import React from "react";

interface StrictProps {
  data: { id: string; name: string };
  format?: "short" | "long";
}

export function StrictCard({ data, format = "short" }: StrictProps) {
  // This will throw if data is undefined (auto-mount with {})
  return (
    <div className="card">
      <strong>{data.name}</strong>
      {format === "long" && <span>{data.id}</span>}
    </div>
  );
}

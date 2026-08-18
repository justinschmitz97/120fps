import React from "react";

interface Entry {
  id: number;
  title: string;
}

interface RegistryProps {
  byId: Map<string, Entry>;
  tags: Set<string>;
  frozen: ReadonlyMap<string, number>;
  label: string;
}

export function Registry({ byId, tags, frozen, label }: RegistryProps) {
  return (
    <div aria-label={label}>
      <span>{byId.size}</span>
      <span>{[...tags].join(",")}</span>
      <span>{frozen.size}</span>
    </div>
  );
}

import React from "react";

interface RosterProps {
  byId: Map<string, string>;
  label: string;
}

export function Roster({ byId, label }: RosterProps) {
  return <div aria-label={label}>{byId.size}</div>;
}

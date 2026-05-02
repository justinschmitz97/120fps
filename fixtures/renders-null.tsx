import React from "react";

interface NullProps {
  visible?: boolean;
}

export function MaybeNull({ visible = false }: NullProps) {
  if (!visible) return null;
  return <div className="visible">Content</div>;
}

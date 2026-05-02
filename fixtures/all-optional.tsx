import React from "react";

interface SpacerProps {
  height?: number;
  width?: number;
  visible?: boolean;
}

export function Spacer({ height = 16, width, visible = true }: SpacerProps) {
  if (!visible) return null;
  return <div style={{ height, width: width ?? "100%" }} />;
}

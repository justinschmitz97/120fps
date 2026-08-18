import React from "react";

export interface InnerImplProps {
  caption: string;
  weight?: number;
}

export function InnerImpl({ caption, weight = 1 }: InnerImplProps) {
  return <strong style={{ fontWeight: weight }}>{caption}</strong>;
}

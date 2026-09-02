import { useState } from "react";

export interface BadgeProps {
  label: string;
}

export default function Badge({ label }: BadgeProps) {
  const [count] = useState(0);
  return <span data-count={count}>{label}</span>;
}

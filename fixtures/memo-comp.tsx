import React from "react";

interface BadgeProps {
  count: number;
  variant?: "info" | "warning" | "error";
  visible?: boolean;
}

function BadgeInner({ count, variant = "info", visible = true }: BadgeProps) {
  if (!visible) return null;
  return <span className={`badge badge-${variant}`}>{count}</span>;
}

export const Badge = React.memo(BadgeInner);
export default Badge;

import React from "react";
import { cva, type VariantProps } from "./cva-lib.js";

const badgeVariants = cva("badge", {
  variants: {
    tone: { neutral: "badge-neutral", danger: "badge-danger" },
    loading: { true: "badge-loading", false: "" },
  },
  defaultVariants: { tone: "neutral", loading: false },
  compoundVariants: [{ tone: "danger", loading: true, class: "badge-danger-loading" }],
});

type BadgeProps = VariantProps<typeof badgeVariants> & { text: string };

export function CvaBadge({ tone, loading, text }: BadgeProps) {
  return <span className={badgeVariants({ tone, loading })}>{text}</span>;
}

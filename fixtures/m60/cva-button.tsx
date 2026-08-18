import React from "react";
import { cva, type VariantProps } from "./cva-lib.js";

const buttonVariants = cva("btn", {
  variants: {
    variant: {
      default: "btn-default",
      destructive: "btn-destructive",
      outline: "btn-outline",
    },
    size: {
      sm: "btn-sm",
      md: "btn-md",
    },
  },
  defaultVariants: { variant: "default", size: "md" },
});

interface ButtonProps extends VariantProps<typeof buttonVariants> {
  label: string;
  asChild?: boolean;
}

export function CvaButton({ label, variant, size, asChild }: ButtonProps) {
  return (
    <button className={buttonVariants({ variant, size })} data-as-child={asChild}>
      {label}
    </button>
  );
}

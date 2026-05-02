import React from "react";

interface FancyBtnProps {
  label: string;
  variant?: "solid" | "outline" | "ghost";
  disabled?: boolean;
}

export const FancyBtn = React.memo(
  React.forwardRef<HTMLButtonElement, FancyBtnProps>(
    ({ label, variant = "solid", disabled = false }, ref) => {
      return (
        <button ref={ref} type="button" className={`btn-${variant}`} disabled={disabled}>
          {label}
        </button>
      );
    },
  ),
);

FancyBtn.displayName = "FancyBtn";

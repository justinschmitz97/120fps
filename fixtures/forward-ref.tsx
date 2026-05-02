import React from "react";

export interface FancyInputProps {
  placeholder?: string;
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
}

export const FancyInput = React.forwardRef<HTMLInputElement, FancyInputProps>(
  ({ placeholder = "", size = "md", disabled = false }, ref) => {
    return (
      <input
        ref={ref}
        placeholder={placeholder}
        className={`input-${size}`}
        disabled={disabled}
      />
    );
  },
);

FancyInput.displayName = "FancyInput";
export default FancyInput;

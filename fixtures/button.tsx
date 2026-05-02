import React from "react";

export interface ButtonProps {
  label: string;
  variant?: "primary" | "secondary" | "ghost";
  disabled?: boolean;
  onClick?: () => void;
  children?: React.ReactNode;
}

export function Button({
  label,
  variant = "primary",
  disabled = false,
  onClick,
  children,
}: ButtonProps) {
  return (
    <button
      type="button"
      className={`btn btn-${variant}`}
      disabled={disabled}
      onClick={onClick}
    >
      {children ?? label}
    </button>
  );
}

export default Button;

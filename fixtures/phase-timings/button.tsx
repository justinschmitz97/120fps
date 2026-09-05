export interface ButtonProps {
  disabled?: boolean;
  variant?: "primary" | "secondary";
  size?: "sm" | "lg";
}

export function Button({ disabled = false, variant = "primary", size = "sm" }: ButtonProps) {
  return (
    <button type="button" className={`btn btn-${variant} btn-${size}`} disabled={disabled}>
      press
    </button>
  );
}

export default Button;

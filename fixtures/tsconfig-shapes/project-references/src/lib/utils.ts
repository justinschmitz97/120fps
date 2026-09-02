export interface ButtonBaseProps {
  variant?: "solid" | "ghost";
  disabled?: boolean;
}

export function cx(...parts: string[]): string {
  return parts.filter(Boolean).join(" ");
}

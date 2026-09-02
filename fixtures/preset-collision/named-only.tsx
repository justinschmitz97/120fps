export interface NamedOnlyProps {
  variant?: "default" | "outline";
  label?: string;
}

export function NamedOnly(props: NamedOnlyProps) {
  return <button data-variant={props.variant}>{props.label}</button>;
}

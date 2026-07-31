export interface OrderedProps {
  label: string;
}

export function Ordered({ label }: OrderedProps) {
  return <div className="ordered">{label}</div>;
}

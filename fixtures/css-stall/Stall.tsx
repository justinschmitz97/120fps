export interface StallProps {
  label: string;
}

export function Stall({ label }: StallProps) {
  return <div className="stall">{label}</div>;
}

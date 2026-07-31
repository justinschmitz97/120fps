export interface BrokenProps {
  label: string;
}

export function Broken({ label }: BrokenProps) {
  return <div className="broken">{label}</div>;
}

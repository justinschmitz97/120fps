export interface ProbeProps {
  label: string;
}

export function Probe({ label }: ProbeProps) {
  return <div className="font-probe">{label}</div>;
}

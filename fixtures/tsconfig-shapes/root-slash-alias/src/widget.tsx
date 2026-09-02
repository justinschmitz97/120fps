export interface WidgetProps {
  label: string;
}

export default function Widget({ label }: WidgetProps) {
  return <div>{label}</div>;
}

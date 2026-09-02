export function Button({ label = "Click" }: { label?: string }) {
  return <button className="border-border">{label}</button>;
}

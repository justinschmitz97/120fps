export function Button({ label = "Click" }: { label?: string }) {
  return <button type="button">{label}</button>;
}

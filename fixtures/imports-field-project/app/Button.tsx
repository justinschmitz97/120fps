import { cn } from "#app/utils/misc";

export default function Button({ label = "Go" }: { label?: string }) {
  return <button className={cn("btn")}>{label}</button>;
}

import { SPACING } from "@/tokens.js";

export function Badge({ label, tone = "neutral" }) {
  return <span style={{ padding: SPACING }} data-tone={tone}>{label}</span>;
}

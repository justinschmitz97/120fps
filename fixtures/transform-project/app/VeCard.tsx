import { card } from "./styles.css";

export function VeCard({ label = "styled" }: { label?: string }) {
  return <div className={card} data-testid="ve-card">{label}</div>;
}

export default VeCard;

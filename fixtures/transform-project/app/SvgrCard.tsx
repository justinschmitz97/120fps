import Icon from "./icon.svg?react";

export function SvgrCard({ label = "icon" }: { label?: string }) {
  return (
    <div className="svgr-card">
      <Icon data-testid="icon" />
      <span>{label}</span>
    </div>
  );
}

export default SvgrCard;

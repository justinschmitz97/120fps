import React from "react";

interface ChipProps {
  text: string;
  color?: "red" | "green" | "blue";
  removable?: boolean;
}

export const Chip: React.FC<ChipProps> = ({ text, color = "blue", removable = false }) => {
  return (
    <span className={`chip chip-${color}`}>
      {text}
      {removable && <button type="button">×</button>}
    </span>
  );
};

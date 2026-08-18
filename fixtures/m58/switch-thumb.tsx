import React from "react";

interface ThumbIconsProps {
  isOn: boolean;
  iconOn: string;
  iconOff: string;
}

// Internal helper in const-arrow form, declared before the exported component.
const ThumbIcons = ({ isOn, iconOn, iconOff }: ThumbIconsProps) => (
  <span>{isOn ? iconOn : iconOff}</span>
);

interface SwitchProps {
  checked: boolean;
  label: string;
  size?: "sm" | "md" | "lg";
}

export function Switch({ checked, label, size = "md" }: SwitchProps) {
  return (
    <button type="button" className={`switch-${size}`} aria-checked={checked}>
      <ThumbIcons isOn={checked} iconOn="on" iconOff="off" />
      {label}
    </button>
  );
}

import React from "react";

export interface LegacyDefaultsProps {
  label?: string;
  count?: number;
}

export function LegacyDefaults(props: LegacyDefaultsProps) {
  return React.createElement("div", null, `${props.label}${props.count}`);
}

LegacyDefaults.defaultProps = {
  label: "legacy",
  count: 4,
};

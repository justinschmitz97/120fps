import React from "react";

interface DeepConfig {
  theme: {
    colors: {
      primary: string;
      secondary: string;
    };
    spacing: number;
  };
}

interface DeepProps {
  config: DeepConfig;
  label: string;
}

export function DeepPropsComp({ config, label }: DeepProps) {
  return (
    <div
      className="deep"
      style={{
        color: config.theme.colors.primary,
        padding: config.theme.spacing,
      }}
    >
      {label}
    </div>
  );
}

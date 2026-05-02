import React from "react";

interface ThemeConfig {
  color: string;
  fontSize: number;
  rounded?: boolean;
}

interface PanelProps {
  title: string;
  theme?: ThemeConfig;
  collapsed?: boolean;
}

export function Panel({ title, theme, collapsed = false }: PanelProps) {
  if (collapsed) return <div className="panel collapsed">{title}</div>;
  return (
    <div
      className="panel"
      style={{
        color: theme?.color,
        fontSize: theme?.fontSize,
        borderRadius: theme?.rounded ? 8 : 0,
      }}
    >
      <h3>{title}</h3>
    </div>
  );
}

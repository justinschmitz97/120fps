import React from "react";

interface BoxProps extends React.HTMLAttributes<HTMLDivElement> {
  padding?: "sm" | "md" | "lg";
  elevation?: number;
}

export function Box({ padding = "md", elevation = 0, children, ...rest }: BoxProps) {
  return (
    <div
      {...rest}
      className={`box box-pad-${padding}`}
      style={{ boxShadow: elevation > 0 ? `0 ${elevation}px ${elevation * 2}px rgba(0,0,0,0.1)` : "none" }}
    >
      {children}
    </div>
  );
}

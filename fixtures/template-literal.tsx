import React from "react";

type ColorToken = `color-${string}`;

interface SwatchProps {
  token: ColorToken;
  label?: string;
  size?: number;
}

export function Swatch({ token, label, size = 32 }: SwatchProps) {
  return (
    <div className="swatch" style={{ width: size, height: size }}>
      <span className={token}>{label ?? token}</span>
    </div>
  );
}

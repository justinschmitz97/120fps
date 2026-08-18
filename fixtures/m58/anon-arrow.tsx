import React from "react";

interface PipProps {
  tone: string;
}

function Pip({ tone }: PipProps) {
  return <b>{tone}</b>;
}

interface ChipProps {
  size: "sm" | "lg";
  text: string;
}

export default ({ size, text }: ChipProps) => (
  <span className={size}>
    <Pip tone={text} />
  </span>
);

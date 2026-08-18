import React from "react";

interface DotProps {
  filled: boolean;
}

function Dot({ filled }: DotProps) {
  return <i>{filled ? "*" : "."}</i>;
}

interface MeterProps {
  ratio: number;
  label: string;
}

export default function ({ ratio, label }: MeterProps) {
  return (
    <div>
      <Dot filled={ratio > 0.5} />
      {label}
    </div>
  );
}

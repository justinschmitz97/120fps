import React, { memo } from "react";

interface SparkParticleProps {
  spark: number;
  color: string;
}

function SparkParticle({ spark, color }: SparkParticleProps) {
  return <i style={{ color }}>{spark}</i>;
}

interface CardProps {
  title: string;
  rows: string[];
  compact?: boolean;
}

export const Card = memo(({ title, rows, compact = false }: CardProps) => (
  <section className={compact ? "compact" : ""}>
    <h2>{title}</h2>
    <SparkParticle spark={rows.length} color="red" />
    {rows.map((row) => (
      <p key={row}>{row}</p>
    ))}
  </section>
));

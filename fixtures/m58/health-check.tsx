import React from "react";

interface ScoreBadgeProps {
  score: number;
}

function ScoreBadge({ score }: ScoreBadgeProps) {
  return <span>{score}</span>;
}

interface FoodHealthCheckProps {
  items: string[];
  strict?: boolean;
}

function FoodHealthCheck({ items, strict = false }: FoodHealthCheckProps) {
  return (
    <div data-strict={strict}>
      <ScoreBadge score={items.length} />
      {items.map((item) => (
        <span key={item}>{item}</span>
      ))}
    </div>
  );
}

export { FoodHealthCheck as default };

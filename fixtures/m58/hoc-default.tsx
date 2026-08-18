import React from "react";

interface LegendProps {
  swatch: string;
}

function Legend({ swatch }: LegendProps) {
  return <span>{swatch}</span>;
}

interface ChartProps {
  series: number[];
  title: string;
  stacked?: boolean;
}

function Chart({ series, title, stacked = false }: ChartProps) {
  return (
    <div data-stacked={stacked}>
      <Legend swatch={title} />
      {series.length}
    </div>
  );
}

function withTheme<P>(Wrapped: React.ComponentType<P>): React.ComponentType<P> {
  return Wrapped;
}

export default withTheme(Chart);

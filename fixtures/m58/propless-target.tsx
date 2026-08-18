import React from "react";

interface RuleProps {
  weight: number;
  tone: string;
}

function Rule({ weight, tone }: RuleProps) {
  return <hr data-weight={weight} data-tone={tone} />;
}

// The target takes no props at all: an empty schema is the answer, not a
// failure, so nothing is warned about.
export function ProplessTarget() {
  return <Rule weight={1} tone="grey" />;
}

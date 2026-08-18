import React from "react";

interface SoloProps {
  alpha: string;
  count?: number;
}

// Nothing in this file is exported: the first declaration stays the target.
function Solo({ alpha, count = 0 }: SoloProps) {
  return <p>{alpha}{count}</p>;
}

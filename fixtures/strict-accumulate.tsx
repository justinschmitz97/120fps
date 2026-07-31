import React, { useLayoutEffect } from "react";

// No cleanup and no dependency list: every invocation bumps a global and does
// work proportional to it. StrictMode's double invoke makes that counter climb
// twice as fast, so strict mounts cost far more than twice a normal one.
// Layout effects flush inside the commit, keeping the cost inside the trace.
export function StrictAccumulate() {
  useLayoutEffect(() => {
    const w = window as unknown as { __120fps_strict_acc?: number; __120fps_strict_sink?: number };
    w.__120fps_strict_acc = (w.__120fps_strict_acc ?? 0) + 1;
    let sum = 0;
    for (let i = 0; i < w.__120fps_strict_acc * 150000; i++) sum += i;
    w.__120fps_strict_sink = sum;
  });

  return <div className="strict-accumulate">accumulating</div>;
}

export default StrictAccumulate;

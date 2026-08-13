import React from "react";

interface MaybeSpinProps {
  spin: boolean;
}

// Animates only when `spin` is true: the M35 vsync fallback must be decided
// per combo, not per component.
export function MaybeSpin({ spin }: MaybeSpinProps) {
  return (
    <div>
      <style>{`@keyframes m35cspin { from { opacity: 0.4; } to { opacity: 1; } }`}</style>
      <div
        style={{
          width: 24,
          height: 24,
          background: "steelblue",
          ...(spin ? { animation: "m35cspin 1s linear infinite" } : {}),
        }}
      />
    </div>
  );
}

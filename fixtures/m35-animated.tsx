import React from "react";

// A running CSS animation inside #root: trips detectAnimations via the
// computed animation-name check, forcing the M35 vsync re-measure path.
export function AnimatedBox() {
  return (
    <div>
      <style>{`@keyframes m35spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <div
        style={{
          animation: "m35spin 1s linear infinite",
          width: 20,
          height: 20,
          background: "rebeccapurple",
        }}
      />
    </div>
  );
}

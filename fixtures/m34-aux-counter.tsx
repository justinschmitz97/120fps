import React from "react";

// Counts profiler aux reads: every detectAnimations() call goes through
// document.getAnimations, and each render bakes the count so far into the DOM
// as one <span> per call. domNodeCount then reveals how many aux reads happened
// before that sample's count was taken.
const original = document.getAnimations.bind(document);
let calls = 0;
(document as unknown as { getAnimations: typeof document.getAnimations }).getAnimations = (
  ...args: Parameters<typeof document.getAnimations>
) => {
  calls += 1;
  return original(...args);
};

export function AuxCounter() {
  return (
    <div>
      {Array.from({ length: calls }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  );
}

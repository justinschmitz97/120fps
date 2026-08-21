import * as React from "react";

// No declaration file. TypeScript infers the parameter type from the
// destructuring defaults, so ADR 0002's "default props only" still holds.
export default function PlainDefaults({ label = "hi", count = 3, muted = false }) {
  return React.createElement("div", { className: muted ? "muted" : "" }, `${label}:${count}`);
}

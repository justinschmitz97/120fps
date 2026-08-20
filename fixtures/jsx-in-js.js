import React from "react";

// M77 regression fixture: plain .js authoring JSX directly (MUI's own
// convention), which only jsxInJsPlugin (src/harness.ts) makes buildable —
// Vite's default esbuild.include excludes plain .js.
export function JsxInJs({ label = "hi" }) {
  return React.createElement("div", { className: "jsx-in-js" }, label);
}

export default JsxInJs;

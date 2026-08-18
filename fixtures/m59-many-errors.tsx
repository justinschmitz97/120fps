import React from "react";

// 26 distinct messages in one render, past the 20-entry cap, and then a throw.
// The cap has to drop the overflow visibly and the throw still has to gate.
export function ManyErrors() {
  for (let i = 0; i < 25; i++) console.error(`ManyErrors: distinct message ${i}`);
  throw new Error("ManyErrors: the real one, logged last");
}

export default ManyErrors;

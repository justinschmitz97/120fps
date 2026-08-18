import React from "react";

// Renders null for every prop combination: a legitimately empty render, with
// nothing thrown. The render-health gate must annotate it, never fail it.
export function RendersNothing() {
  return null;
}

export default RendersNothing;

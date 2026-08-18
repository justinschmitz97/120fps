import React from "react";

// Renders nothing and logs through console.error the way React's own dev
// warnings do. Nothing was thrown, so the gate must annotate rather than fail.
export function ConsoleNoise() {
  console.error("Warning: Each child in a list should have a unique \"key\" prop.");
  return null;
}

export default ConsoleNoise;

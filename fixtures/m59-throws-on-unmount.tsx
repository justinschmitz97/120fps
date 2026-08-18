import React from "react";

// Mounts and renders normally; the effect cleanup throws on unmount. The DOM
// is real, so the gate must not fire, and the error still has to be reported.
export function ThrowsOnUnmount() {
  React.useEffect(() => () => {
    throw new Error("ThrowsOnUnmount: cleanup blew up");
  }, []);
  return <div className="rendered">content</div>;
}

export default ThrowsOnUnmount;

import React from "react";

// Mounts cleanly and throws on the first update of the same instance. Every
// mount/unmount sample succeeds; only the rerender pass sees the throw.
export function ThrowsOnUpdate({ label = "a" }: { label?: string }) {
  const firstRender = React.useRef(true);
  React.useEffect(() => {
    firstRender.current = false;
  });
  if (!firstRender.current) throw new Error("ThrowsOnUpdate: update render blew up");
  return <div className="rendered">{label}</div>;
}

export default ThrowsOnUpdate;

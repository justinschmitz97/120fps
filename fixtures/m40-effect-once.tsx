import { useEffect, useState } from "react";

// The most common React shape: one passive effect that sets state once. It must
// settle inside the mount fence, not read as a late mutation.
export function EffectOnce() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);
  return <div data-testid="body">{ready ? "ready" : "init"}</div>;
}

export default EffectOnce;

import { useEffect, useState } from "react";

// A ticking timestamp: every state hash would differ from the last, so every
// interaction would look state-changing.
export function VolatileClock() {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30);
    return () => clearInterval(id);
  }, []);
  return (
    <div>
      <span data-testid="clock">{now}</span>
      <button onClick={() => undefined}>noop</button>
    </div>
  );
}

export default VolatileClock;

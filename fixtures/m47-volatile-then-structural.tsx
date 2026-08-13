import { useEffect, useState } from "react";

// The clock churns on its own; the button adds a real element. Structural
// change through a volatile region must still register as state.
export function VolatileThenStructural() {
  const [now, setNow] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30);
    return () => clearInterval(id);
  }, []);
  return (
    <div>
      <span data-testid="clock">{now}</span>
      <button onClick={() => setOpen((v) => !v)}>toggle</button>
      {open ? <p data-testid="panel">panel</p> : null}
    </div>
  );
}

export default VolatileThenStructural;

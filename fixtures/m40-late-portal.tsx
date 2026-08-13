import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

// The late change lands on document.body, not inside #root.
export function LatePortal() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setOpen(true), 30);
    return () => clearTimeout(t);
  }, []);
  return open ? createPortal(<div data-testid="portal">portal</div>, document.body) : null;
}

export default LatePortal;

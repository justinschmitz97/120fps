import { useState } from "react";

export function Plain() {
  const [open] = useState(false);
  return <div>{String(open)}</div>;
}

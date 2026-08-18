import { useEffect, useState } from "react";

// Content that keeps arriving after mount: a streaming response, a progress
// readout, a poll.
//
// An interval rather than a one-shot timer: the observation window opens only
// once trace collection has finished, which is hundreds of milliseconds after
// the fence and varies with machine load. A single late update can land in that
// blind spot; a repeating one is caught by any window, whenever it opens.
const TICK_MS = 40;
const TICKS = 60;

export function LateMutation() {
  const [text, setText] = useState("skeleton");
  useEffect(() => {
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      setText(`content ${n}`);
      if (n >= TICKS) clearInterval(id);
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);
  return <div data-testid="body">{text}</div>;
}

export default LateMutation;

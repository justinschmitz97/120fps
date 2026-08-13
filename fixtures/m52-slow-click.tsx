import { useState } from "react";

// A click whose handler blocks long enough to clear the Event Timing reporting
// threshold, so the observer has something real to report.
export function SlowClick() {
  const [count, setCount] = useState(0);
  return (
    <button
      onClick={() => {
        const until = performance.now() + 60;
        while (performance.now() < until) {
          /* block the main thread */
        }
        setCount((c) => c + 1);
      }}
    >
      clicked {count}
    </button>
  );
}

export default SlowClick;

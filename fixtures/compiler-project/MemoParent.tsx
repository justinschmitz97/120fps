import { useState } from "react";

function MemoChild({ label }: { label: string }) {
  return <span className="memo-child">{label}</span>;
}

export interface MemoParentProps {
  label?: string;
}

// The child receives only a primitive that does not change across a same-props
// rerender, so React Compiler can cache its element and React can bail out of
// re-rendering it. Without the compiler the element is recreated every render
// and the child re-renders, which is what detectMemoBailouts reports.
export function MemoParent({ label = "child" }: MemoParentProps) {
  const [clicks, setClicks] = useState(0);
  return (
    <div className="memo-parent">
      <MemoChild label={label} />
      <button type="button" onClick={() => setClicks(clicks + 1)}>
        {clicks}
      </button>
    </div>
  );
}

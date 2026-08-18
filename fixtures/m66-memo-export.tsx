import { memo } from "react";

// The measured component is itself memoized, so an unchanged callback prop lets
// the whole render bail out and a fresh one costs the entire subtree.
export const MemoPanel = memo(function MemoPanel({ onAction }: { onAction: () => void }) {
  const rows = [];
  for (let i = 0; i < 900; i++) {
    rows.push(
      <div key={i} className="row" onClick={onAction}>
        <span>{`row ${i}`}</span>
      </div>,
    );
  }
  return <div className="heavy">{rows}</div>;
});

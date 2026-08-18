import { memo } from "react";

const Heavy = memo(function Heavy({ onAction }: { onAction: () => void }) {
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

// The component rebinds the callback on every render, so the memoized child
// re-renders whatever the caller passes. Stabilizing the caller's function would
// change nothing, so this is not a callback-identity finding.
export function ReboundPanel({ onAction }: { onAction: () => void }) {
  const handler = onAction.bind(null);
  return (
    <div>
      <Heavy onAction={handler} />
    </div>
  );
}

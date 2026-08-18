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

// The callback prop reaches a memoized child directly, so a fresh function on
// every render forces the whole subtree to re-render.
export function CallbackSensitive({ onAction }: { onAction: () => void }) {
  return (
    <div>
      <Heavy onAction={onAction} />
    </div>
  );
}

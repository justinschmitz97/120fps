import { memo, useReducer } from "react";

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

// The memoized child receives the useReducer dispatch, which React keeps
// referentially stable, so no re-render of Heavy can be blamed on callback
// identity. The `dispatch` prop is accepted and never forwarded.
export function ReducerPanel({ dispatch }: { dispatch?: (action: { type: string }) => void }) {
  const [count, tick] = useReducer((s: number) => s + 1, 0);
  void dispatch;
  return (
    <div>
      <button onClick={() => tick()}>{count}</button>
      <Heavy onAction={tick} />
    </div>
  );
}

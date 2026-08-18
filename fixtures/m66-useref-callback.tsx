import { memo, useRef } from "react";

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

// The callback the memoized child receives lives in a ref, so its identity is
// fixed for the component's lifetime. The `onAction` prop is never forwarded.
export function RefCallbackPanel({ onAction }: { onAction?: () => void }) {
  void onAction;
  const handler = useRef(() => {}).current;
  return (
    <div>
      <Heavy onAction={handler} />
    </div>
  );
}

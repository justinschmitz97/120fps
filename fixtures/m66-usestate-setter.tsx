import { memo, useState } from "react";

const Heavy = memo(function Heavy({ onAction }: { onAction: (v: number) => void }) {
  const rows = [];
  for (let i = 0; i < 900; i++) {
    rows.push(
      <div key={i} className="row" onClick={() => onAction(i)}>
        <span>{`row ${i}`}</span>
      </div>,
    );
  }
  return <div className="heavy">{rows}</div>;
});

// React keeps the useState setter referentially stable, so the memoized child
// never re-renders because of it. The `onChange` prop is accepted and never
// forwarded.
export function SetterPanel({ onChange }: { onChange?: (v: number) => void }) {
  const [value, setValue] = useState(0);
  void onChange;
  return (
    <div>
      <output>{value}</output>
      <Heavy onAction={setValue} />
    </div>
  );
}

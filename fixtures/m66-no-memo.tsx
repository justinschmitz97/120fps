// Nothing in the tree is memoized and the callback prop is never forwarded, so
// both callback-identity arms re-render the whole list. Any reported delta is
// the machine's drift, which at this size is tens of milliseconds.
export function NoMemoList({ onAction }: { onAction?: () => void }) {
  void onAction;
  const rows = [];
  for (let i = 0; i < 900; i++) {
    rows.push(
      <div key={i} className="row">
        <span>{`row ${i}`}</span>
      </div>,
    );
  }
  return <div className="list">{rows}</div>;
}

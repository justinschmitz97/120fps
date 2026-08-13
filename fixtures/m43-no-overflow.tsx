// overflow: auto, but the content fits. Style alone must not claim a sweep.
export function NoOverflow() {
  return (
    <div data-testid="fits" style={{ height: 200, overflowY: "auto", width: 300 }}>
      <div style={{ height: 30 }}>only row</div>
    </div>
  );
}

export default NoOverflow;

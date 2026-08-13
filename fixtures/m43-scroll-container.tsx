// A fixed-height scrollport with more rows than fit: the shape every list,
// table and virtualized component shares.
export function ScrollContainer({ rows = 60 }: { rows?: number }) {
  return (
    <div
      data-testid="scrollport"
      style={{ height: 200, overflowY: "auto", width: 300 }}
    >
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ height: 30 }}>
          row {i}
        </div>
      ))}
    </div>
  );
}

export default ScrollContainer;

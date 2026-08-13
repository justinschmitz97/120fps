export function ScrollHorizontal() {
  return (
    <div
      data-testid="scrollport-x"
      style={{ width: 200, overflowX: "auto", overflowY: "hidden", whiteSpace: "nowrap" }}
    >
      {Array.from({ length: 40 }, (_, i) => (
        <span key={i} style={{ display: "inline-block", width: 80 }}>
          col {i}
        </span>
      ))}
    </div>
  );
}

export default ScrollHorizontal;

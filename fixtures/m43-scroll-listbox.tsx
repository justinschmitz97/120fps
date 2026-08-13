// Scrollable and a listbox: the keyboard sweep measures more here than a
// wheel would, so the ARIA type must win.
export function ScrollListbox() {
  return (
    <div
      role="listbox"
      data-testid="listbox"
      style={{ height: 120, overflowY: "auto", width: 200 }}
    >
      {Array.from({ length: 30 }, (_, i) => (
        <div role="option" key={i} style={{ height: 24 }}>
          option {i}
        </div>
      ))}
    </div>
  );
}

export default ScrollListbox;

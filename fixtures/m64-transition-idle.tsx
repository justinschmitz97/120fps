// A static toolbar carrying Tailwind's `transition-all` shape: every element
// declares a transition, nothing ever transitions. Six nodes, T1 by size.
// Before M64 the declared transition read as animation and forced T3.
export function IdleToolbar() {
  const transition = { transition: "all 150ms ease-in-out" } as const;
  return (
    <div style={transition}>
      <button style={transition}>Save</button>
      <button style={transition}>Undo</button>
      <span style={transition}>
        <em style={transition}>idle</em>
      </span>
    </div>
  );
}

export default IdleToolbar;

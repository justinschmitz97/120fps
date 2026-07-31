declare global {
  interface Window {
    __childRenders?: number;
  }
}

function CountingChild({ label }: { label: string }) {
  window.__childRenders = (window.__childRenders ?? 0) + 1;
  return <span className="counting-child">{label}</span>;
}

export interface RenderCountProps {
  label?: string;
}

// The child's only prop is a primitive that does not change across a same-props
// rerender, so the compiler caches the element the parent creates for it and
// React skips the child. Without the compiler the element is new every render.
export function RenderCount({ label = "child" }: RenderCountProps) {
  return (
    <div className="render-count">
      <CountingChild label={label} />
    </div>
  );
}

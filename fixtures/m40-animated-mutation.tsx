import { useEffect, useState } from "react";

// Animates and mutates: the mutation must not be held against it.
export function AnimatedMutation() {
  const [text, setText] = useState("a");
  useEffect(() => {
    const t = setTimeout(() => setText("b"), 30);
    return () => clearTimeout(t);
  }, []);
  return (
    <div data-testid="body" style={{ animation: "m40spin 2s linear infinite" }}>
      <style>{"@keyframes m40spin { from { opacity: 1 } to { opacity: 0.5 } }"}</style>
      {text}
    </div>
  );
}

export default AnimatedMutation;

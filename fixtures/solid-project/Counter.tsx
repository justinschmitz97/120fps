import { createSignal } from "solid-js";

export function Counter(props: { start: number }) {
  const [count, setCount] = createSignal(props.start);
  return <button onClick={() => setCount(count() + 1)}>{count()}</button>;
}

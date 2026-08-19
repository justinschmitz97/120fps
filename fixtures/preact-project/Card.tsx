import { useState } from "preact/hooks";

export function Card(props: { title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <button onClick={() => setOpen(!open)}>{props.title}</button>
      {open ? <p>body</p> : null}
    </section>
  );
}

import React, { useState } from "react";

function AccordionItem({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {title}
      </button>
      {open && <div role="region">{children}</div>}
    </div>
  );
}

export default function AccordionScene() {
  return (
    <div data-accordion>
      <AccordionItem title="Section 1">Content 1</AccordionItem>
      <AccordionItem title="Section 2">Content 2</AccordionItem>
    </div>
  );
}

export function scale(n: number) {
  return (
    <div data-accordion>
      {Array.from({ length: n }, (_, i) => (
        <AccordionItem key={i} title={`Section ${i + 1}`}>
          Content {i + 1}
        </AccordionItem>
      ))}
    </div>
  );
}

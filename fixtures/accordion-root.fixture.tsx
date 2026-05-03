import React, { useState } from "react";
import { Accordion } from "./accordion-root";

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
    <Accordion>
      <AccordionItem title="Section 1">Content 1</AccordionItem>
      <AccordionItem title="Section 2">Content 2</AccordionItem>
      <AccordionItem title="Section 3">Content 3</AccordionItem>
    </Accordion>
  );
}

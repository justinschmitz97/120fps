import { createContext, useContext, type ReactNode } from "react";

// Stands in for a Radix-style compound component: the parts refuse to render
// outside their required parent, so a structurally inferred tree that nests
// them wrongly mounts to an empty root.
const SlotContext = createContext<string | null>(null);

export function Panel({ children }: { children?: ReactNode }) {
  return <SlotContext.Provider value="panel">{children}</SlotContext.Provider>;
}

export function PanelGroup({ children }: { children?: ReactNode }) {
  return <div data-part="group">{children}</div>;
}

export function PanelContent({ children }: { children?: ReactNode }) {
  return <div data-part="content">{children}</div>;
}

export function PanelItem({ children }: { children?: ReactNode }) {
  const slot = useContext(SlotContext);
  if (slot !== "content") throw new Error("`PanelItem` must be used within `PanelContent`");
  return <div data-part="item">{children}</div>;
}

export function PanelTrigger({ children }: { children?: ReactNode }) {
  const slot = useContext(SlotContext);
  if (slot !== "content") throw new Error("`PanelTrigger` must be used within `PanelContent`");
  return <button type="button">{children}</button>;
}

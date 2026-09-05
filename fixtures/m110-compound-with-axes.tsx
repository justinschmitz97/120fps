import { type ReactNode } from "react";

// M110 review: a compound component whose root carries both matrix axes and an
// array prop, so a dry run over it exercises the composed scene against the
// matrix predicate and against curve detection at the same time.
export function Deck({
  items,
  variant,
  disabled,
  children,
}: {
  items?: string[];
  variant?: "solid" | "ghost";
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div data-part="deck" data-variant={variant} data-disabled={disabled}>
      {items?.map((item) => <span key={item}>{item}</span>)}
      {children}
    </div>
  );
}

export function DeckHeader({ children }: { children?: ReactNode }) {
  return <div data-part="header">{children}</div>;
}

export function DeckBody({ children }: { children?: ReactNode }) {
  return <div data-part="body">{children}</div>;
}

export function DeckCard({ children }: { children?: ReactNode }) {
  return <div data-part="card">{children}</div>;
}

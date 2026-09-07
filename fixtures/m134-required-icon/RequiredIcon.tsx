import type { ElementType } from "react";

// `icon` has no default and is dereferenced on every render, so a copy mounted without it throws
// `Element type is invalid` rather than rendering an empty tree.
export function RequiredIcon({ icon: Icon, title }: { icon: ElementType; title: string }) {
  return (
    <div className="empty-state">
      <Icon />
      <p>{title}</p>
    </div>
  );
}

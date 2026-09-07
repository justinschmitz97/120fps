import type { ElementType } from "react";

// The shape dub's empty state declares: a required slot that takes a tag name or a component.
export interface EmptyStateProps {
  icon: ElementType;
  component?: ElementType;
  as?: ElementType;
  title: string;
}

export function EmptyState({ icon: Icon, component: Wrapper = "div", title }: EmptyStateProps) {
  return (
    <Wrapper>
      <Icon />
      {title}
    </Wrapper>
  );
}

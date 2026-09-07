// A design-system size: a literal union the extractor already reads correctly.
export interface BadgeProps {
  size?: "sm" | "lg";
}

export function Badge(props: BadgeProps) {
  return <span data-size={props.size} />;
}

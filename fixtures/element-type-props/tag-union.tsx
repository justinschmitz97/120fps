// A hand-written tag union: an enumeration the extractor must keep, not an element type.
export interface HeadingProps {
  level?: "div" | "span" | "button";
}

export function Heading({ level = "div" }: HeadingProps) {
  return <div data-level={level} />;
}

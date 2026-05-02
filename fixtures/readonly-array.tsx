import React from "react";

interface TagListProps {
  tags: readonly string[];
  max?: number;
  onRemove?: (tag: string) => void;
}

export function TagList({ tags, max = 10, onRemove }: TagListProps) {
  return (
    <ul>
      {tags.slice(0, max).map((tag) => (
        <li key={tag}>
          {tag}
          {onRemove && <button type="button" onClick={() => onRemove(tag)}>×</button>}
        </li>
      ))}
    </ul>
  );
}

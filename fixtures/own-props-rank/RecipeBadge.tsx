import React from "react";

// chakra's shape: the component is produced by a factory call, so there is no
// render function whose body a source-reference scan could read.
type RecipeProps = {
  colorPalette?: unknown;
  size?: unknown;
  variant?: unknown;
};

export interface RecipeBadgeProps
  extends RecipeProps,
    React.HTMLAttributes<HTMLSpanElement> {
  unstyled?: boolean;
}

function withContext<P>(tag: string): React.FC<P> {
  return ((props: P) => React.createElement(tag, props as object)) as React.FC<P>;
}

export const RecipeBadge = withContext<RecipeBadgeProps>("span");

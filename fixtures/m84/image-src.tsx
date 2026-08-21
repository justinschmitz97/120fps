import React from "react";

// M84: element-plus-F2. `src`/`srcSet`/`poster` synthesize a bare "test"
// placeholder today, which relative-resolves against the harness origin and
// 404s. They must synthesize an inline `data:` URI instead.
export interface AvatarProps {
  src?: string;
  srcSet?: string;
  poster?: string;
}

export function Avatar(props: AvatarProps) {
  return <img src={props.src} srcSet={props.srcSet} />;
}

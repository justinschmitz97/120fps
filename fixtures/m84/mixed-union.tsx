import React from "react";

// M84: base-ui-F3. A union mixing a primitive type with a string/number
// literal matches none of classifyType's pure-kind branches (not a pure
// literal union, not boolean-only) and today falls to kind:"unknown" with an
// empty value and zero disclosure.
export interface DialogRootProps {
  modal?: boolean | "trap-focus";
  step?: number | "any";
  // A plain string with no name-based heuristic match: the placeholder
  // provenance control for prop-provenance.test.ts.
  description?: string;
}

export function DialogRoot(props: DialogRootProps) {
  return (
    <div data-modal={String(props.modal)} data-step={String(props.step)} title={props.description} />
  );
}

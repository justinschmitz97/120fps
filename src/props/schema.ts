// How a schema's value(s) were chosen. A combo's `harnessFault` keys on
// this. "declared": a real literal or union
// member from the type. "preset": from a `<stem>.props.tsx` (set only by
// `applyPropPresets`, never assigned in this file). "heuristic": a name-based
// special case such as `currencyCode`. "placeholder": a generic, type-agnostic
// fill such as `"test"`. "contract": a value whose truthiness imposes a
// requirement on other props, such as `asChild`.
export type PropProvenance = "declared" | "preset" | "heuristic" | "placeholder" | "contract";


export interface PropSchema {
  name: string;
  kind:
    | "boolean"
    | "string"
    | "number"
    | "union"
    | "array"
    | "function"
    | "reactnode"
    | "object"
    | "unknown";
  required: boolean;
  values: unknown[];
  // Array props only: a value shaped like one element, synthesized from the
  // element type. Absent when the element type has no synthesizable shape.
  elementTemplate?: unknown;
  // Why the generated value is not a faithful stand-in for the declared
  // type. Set means the component is measured with something it cannot use.
  degenerate?: string;
  // How the value(s) above were chosen. See `PropProvenance`.
  provenance?: PropProvenance;
  // The default the component itself declares, when it
  // is a literal the AST can read. Absent means no default was declared or the
  // declared one is not a literal — never "the default is undefined".
  defaultValue?: unknown;
  defaultSource?: "destructuring" | "withDefaults" | "defaultProps";
}


export interface ScalingPropMatch {
  schema: PropSchema;
  kind: "numeric" | "array";
  reason: string;
}


// The extraction warnings a preset loaded afterwards can change,
// carried as data beside their printed text so a caller can re-render them
// against the applied schema instead of parsing a line.
export interface PropWarningRecord {
  kind: "prop-cap" | "collapsed-union" | "degenerate";
  // The component file's basename without its extension.
  stem: string;
  text: string;
}


export type WarningRecorder = (record: PropWarningRecord) => void;

export interface ExportInfo {
  name: string;
  isDefault: boolean;
}

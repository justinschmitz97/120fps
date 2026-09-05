// Defined only at the assignment sites in classify.ts and presets.ts; harnessFault keys on it.
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
  // Absent when the element type has no synthesizable shape.
  elementTemplate?: unknown;
  // Set means the component is measured with a value it cannot use.
  degenerate?: string;
  provenance?: PropProvenance;
  // Absent means no literal default was read; never "the default is undefined".
  defaultValue?: unknown;
  defaultSource?: "destructuring" | "withDefaults" | "defaultProps";
}


export interface ScalingPropMatch {
  schema: PropSchema;
  kind: "numeric" | "array";
  reason: string;
}


// Carried as data beside the printed text so a caller can re-render against the applied schema.
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

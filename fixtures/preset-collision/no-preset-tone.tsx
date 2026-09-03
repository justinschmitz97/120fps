// M112 C1: the same collapsed union as wide.tsx, with no preset sibling on
// disk. The remedy for `tone` must print here, so the wide.tsx assertion that
// it does not print has a subject.
export interface NoPresetToneProps {
  tone?: "solid" | { level: number };
}

export function NoPresetTone(props: NoPresetToneProps) {
  return <div data-tone={typeof props.tone === "string" ? props.tone : "object"} />;
}

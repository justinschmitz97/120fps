import React from "react";

// M86: `onKeyDown` is purely inherited (via `MergedHTMLAttributes`), never
// referenced in the component's own body, and not required — with nothing
// but Tier-3 volume ranking, the cap drops it. A `<stem>.props.tsx` preset
// naming it must restore it to the measured schema, and must not be
// rejected with "not a prop of the measured component".
type MergedHTMLAttributes = Omit<
  React.HTMLAttributes<HTMLElement> & React.ButtonHTMLAttributes<HTMLElement>,
  "color"
>;

export interface PresetTargetProps extends MergedHTMLAttributes {
  loading?: boolean;
}

export function PresetTarget(props: PresetTargetProps) {
  return <button disabled={props.loading} />;
}

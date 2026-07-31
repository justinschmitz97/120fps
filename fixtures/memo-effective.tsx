import { memo } from "react";

const StableChild = memo(function StableChild({ label }: { label: string }) {
  return <span>{label}</span>;
});

const DefeatedChild = memo(function DefeatedChild({ config }: { config: { on: boolean } }) {
  return <span>{config.on ? "on" : "off"}</span>;
});

export interface MemoEffectiveProps {
  label: string;
}

export function MemoEffective({ label }: MemoEffectiveProps) {
  // A fresh object every render defeats DefeatedChild's shallow prop compare,
  // while StableChild's string prop stays equal.
  return (
    <div>
      <StableChild label={label} />
      <DefeatedChild config={{ on: true }} />
    </div>
  );
}

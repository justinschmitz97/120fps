import React from "react";

// M86 harden fixtures.

export interface NoParamsProps {}
export function NoParams() {
  return <span />;
}

// A destructured parameter naming a prop that is itself Tier-3-shaped.
type Merged = Omit<React.HTMLAttributes<HTMLElement> & React.ButtonHTMLAttributes<HTMLElement>, "color">;
export interface DestructuredProps extends Merged {
  loading?: boolean;
}
export function Destructured({ onDoubleClick, loading }: DestructuredProps) {
  return <button disabled={loading} onDoubleClick={onDoubleClick} />;
}

// A nested destructuring inside the body: const { onWheel } = props.
export interface NestedDestructureProps extends Merged {
  loading?: boolean;
}
export function NestedDestructure(props: NestedDestructureProps) {
  const { onWheel } = props;
  return <div onWheel={onWheel} />;
}

// Two components in one file, so `collectComponentCandidates` must attribute
// the right function body to the right target.
export interface FirstProps extends Merged {
  variantOnly?: boolean;
}
export function First(props: FirstProps) {
  return <div onDrag={props.onDrag} />;
}
export interface SecondProps extends Merged {
  variantOnly?: boolean;
}
export function Second(props: SecondProps) {
  return <div onScroll={props.onScroll} />;
}

// Many required props at once (edge of the "required bypasses cap" rule).
export interface ManyRequiredProps extends Merged {
  a: string;
  b: string;
  c: string;
  d: string;
  e: string;
}
export function ManyRequired(props: ManyRequiredProps) {
  return <div>{props.a}{props.b}{props.c}{props.d}{props.e}</div>;
}

import React from "react";

// M84 harden fixtures: adversarial shapes for the depth-independent naming
// heuristic, the identity-collection fallback, and the mixed/multi-branch
// union paths.

export interface DeepNestProps {
  // Two levels deep: label.meta.currencyCode.
  label: { meta: { currencyCode: string } };
}
export function DeepNest(props: DeepNestProps) {
  return <span />;
}

export interface CaseInsensitiveProps {
  SRC: string;
  CurrencyCode: string;
}
export function CaseInsensitive(props: CaseInsensitiveProps) {
  return <img src={props.SRC} />;
}

export interface NearMissProps {
  // Looks image-like but is not an exact-name match: must NOT get the
  // data: URI heuristic (deliberately narrow allowlist).
  sourceUrl: string;
  imgSrc: string;
}
export function NearMiss(props: NearMissProps) {
  return <span>{props.sourceUrl}{props.imgSrc}</span>;
}

export interface ArrayOfCurrencyProps<T> {
  // Array elements have no single "name" to test a heuristic against; this
  // documents the accepted limitation rather than asserting a false fix.
  currencyCodes: string[];
  rows: T[];
}
export function ArrayOfCurrency<T>(props: ArrayOfCurrencyProps<T>) {
  return <span />;
}

export interface EmptyObjectProps {
  label: {};
}
export function EmptyObjectHost(props: EmptyObjectProps) {
  return <span />;
}

export interface OptionalUndefinedLiteralProps {
  // A literal union with only one real member once undefined strips away —
  // must not crash the mixed-union fallback.
  mode?: "solo" | undefined;
}
export function OptionalUndefinedLiteral(props: OptionalUndefinedLiteralProps) {
  return <span />;
}

export interface TripleMixedProps {
  // Three-way mix: two literals plus a primitive.
  align?: "start" | "end" | number;
}
export function TripleMixed(props: TripleMixedProps) {
  return <span />;
}

export interface AsChildStringProps {
  // "as" used polymorphically as a string-literal union, not boolean —
  // provenance:"contract" must apply regardless of the resulting kind.
  as?: "div" | "span";
}
export function AsChildString(props: AsChildStringProps) {
  return <span />;
}

export interface NestedIdentityProps {
  // A nested (not top-level) array whose element type is unresolved and
  // whose name matches the identity-collection pattern.
  wrapper: { items: unknown[] };
}
export function NestedIdentity(props: NestedIdentityProps) {
  return <span />;
}

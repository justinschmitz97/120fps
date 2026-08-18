import React from "react";

interface RowProps {
  label: string;
  count: number;
}

function Row({ label, count }: RowProps) {
  return <tr><td>{label}</td><td>{count}</td></tr>;
}

// The target's own parameter carries no type, so nothing binds to it. The
// helper above must not supply the schema in its place.
// @ts-expect-error - implicit any parameter is the point of this fixture
export function Table(props) {
  return <table><tbody><Row label={String(props?.title)} count={1} /></tbody></table>;
}

import React from "react";

interface RealProps {
  alpha: string;
  beta: number;
}

function Inner({ alpha, beta }: RealProps) {
  return <span>{alpha}{beta}</span>;
}

interface StaleProps {
  gamma: boolean;
}

// The annotation drifted away from what the component destructures, so the
// declared type shares no key with the parameter's binding names.
// @ts-expect-error - the mismatch is the point of this fixture
export function Widget({ alpha, beta }: StaleProps) {
  return <Inner alpha={alpha} beta={beta} />;
}

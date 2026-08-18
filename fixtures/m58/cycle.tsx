import React, { memo } from "react";

interface TileProps {
  label: string;
  index: number;
}

function Tile({ label, index }: TileProps) {
  return <li>{label}{index}</li>;
}

// A wrapper cycle: following the identifier must terminate, and the internal
// helper above must not be substituted for the unresolvable target.
// @ts-expect-error - the cycle is the point of this fixture
const Loop: React.ComponentType = memo(Ping);
const Ping: React.ComponentType = memo(Loop);

export default Loop;

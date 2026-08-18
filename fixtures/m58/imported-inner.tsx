import React, { memo } from "react";
import { InnerImpl } from "./inner-impl.js";

interface LocalHelperProps {
  noise: string;
}

function LocalHelper({ noise }: LocalHelperProps) {
  return <span>{noise}</span>;
}

// The wrapped component lives in another module, so the props come off the
// wrapper's own call signature.
export default memo(InnerImpl);

export { LocalHelper };

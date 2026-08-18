import React from "react";
import { createPortal } from "react-dom";

function PortalChild(): React.ReactElement {
  throw new Error("PortalChild: portal content blew up");
}

// Everything this component renders lives in a portal, and the portal child
// throws. Nothing reaches the DOM, in #root or on body.
export function PortalThrows() {
  return createPortal(<PortalChild />, document.body);
}

export default PortalThrows;

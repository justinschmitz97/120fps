import * as React from "react";

// forwardRef with an unannotated render parameter and no sibling .d.ts: the
// binding degrades to ForwardRefExoticComponent<RefAttributes<any>>, whose only
// properties are React's own `ref` and `key`.
const WrappedNoTypes = React.forwardRef(function WrappedNoTypes(props, ref) {
  return React.createElement("div", { ref }, props.children);
});

export default WrappedNoTypes;

import * as React from "react";

// No declaration file and no inferable parameter type: nothing to extract.
export default function Bare(props) {
  return React.createElement("div", null, props.anything);
}

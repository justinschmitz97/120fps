import React from "react";

// Every member comes from React's own types: there is nothing of the
// component's own to enumerate.
export function NativeButton(props: React.ComponentProps<"button">) {
  return <button {...props} />;
}

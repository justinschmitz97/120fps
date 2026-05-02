import React from "react";

export function RoleButtonDiv() {
  return (
    <div>
      <div role="button" tabIndex={0}>Click this div</div>
      <span role="link" tabIndex={0}>Span link</span>
    </div>
  );
}

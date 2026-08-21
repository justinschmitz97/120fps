import * as React from "react";

// Mirrors MUI's shipped shape: a .js implementation whose types live in a
// sibling .d.ts, with an unannotated forwardRef render parameter.
const Badge = React.forwardRef(function Badge(inProps, ref) {
  const {
    badgeContent,
    color = "default",
    invisible = false,
    max = 99,
    variant = "standard",
    children,
    component: Component = "span",
  } = inProps;
  const shown = invisible ? null : badgeContent > max ? `${max}+` : badgeContent;
  return React.createElement(
    Component,
    { ref, className: `badge badge-${color} badge-${variant}` },
    children,
    React.createElement("span", { className: "badge-dot" }, shown),
  );
});

export default Badge;

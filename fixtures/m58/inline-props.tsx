import React from "react";

type CrumbProps = {
  href: string;
  current: boolean;
};

function Crumb({ href, current }: CrumbProps) {
  return <a href={href} aria-current={current ? "page" : undefined} />;
}

// Props declared inline rather than through a named type.
export function Breadcrumbs(props: { trail: string[]; separator?: string }) {
  return (
    <nav>
      {props.trail.map((step) => (
        <Crumb key={step} href={step} current={false} />
      ))}
      {props.separator ?? "/"}
    </nav>
  );
}

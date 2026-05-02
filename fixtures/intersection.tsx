import React from "react";

interface BaseProps {
  id: string;
  className?: string;
}

interface ActionProps {
  onClick?: () => void;
  disabled?: boolean;
}

type CardProps = BaseProps & ActionProps & {
  title: string;
  subtitle?: string;
};

export function Card({ id, className, onClick, disabled, title, subtitle }: CardProps) {
  return (
    <div id={id} className={className} onClick={disabled ? undefined : onClick}>
      <h2>{title}</h2>
      {subtitle && <p>{subtitle}</p>}
    </div>
  );
}

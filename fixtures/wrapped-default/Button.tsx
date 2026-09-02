import React from "react";

interface ButtonProps {
  size?: "small" | "large";
  disabled?: boolean;
}

interface LinkButtonProps {
  href: string;
}

// logto-F1's shape: a named sibling is declared first, the default export is a
// wrapper call over the component the header should name.
export const LinkButton = ({ href }: LinkButtonProps) => <a href={href}>link</a>;

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ size = "small", disabled = false }, ref) => (
    <button ref={ref} data-size={size} disabled={disabled} />
  ),
);

export default React.memo(Button);

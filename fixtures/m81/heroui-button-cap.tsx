import React from "react";
import type { AriaButtonProps } from "aria-button";

// Mirrors heroui-F1: `ButtonVariants` reached through `extends` produces
// zero-declaration `variant`/`size` members. A NON-homomorphic mapped type
// (`{ [P in K]: V }` for a literal-union `K`, unlike `{ [P in keyof T]: ... }`)
// has no source object to trace a declaration back to, so
// `prop.getDeclarations()` is genuinely `undefined` — verified directly
// against the TS compiler API, not assumed. `tailwind-variants`' real
// `VariantProps<typeof tv(...)>` produces the same shape. These compete
// against react-aria-components' ~35 declared-in-node_modules passthrough
// props (AriaButtonProps) for the 32-prop cap.
type VariantMap<K extends string, V> = { [P in K]: V };
type ButtonVariants = VariantMap<"variant", "solid" | "bordered" | "light"> &
  VariantMap<"size", "sm" | "md" | "lg">;

export interface ButtonProps extends AriaButtonProps, ButtonVariants {}

export function Button({ variant, size, ...rest }: ButtonProps) {
  return <button data-variant={variant} data-size={size} {...rest} />;
}

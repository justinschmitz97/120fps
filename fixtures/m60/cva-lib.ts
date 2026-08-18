// The `class-variance-authority` type surface, reproduced locally so the
// fixture needs no dependency: a generic factory whose returned function takes
// a homomorphic mapped type over the variants object.
type ClassValue = string | null | undefined | false;

type ConfigSchema = Record<string, Record<string, ClassValue>>;

type StringToBoolean<T> = T extends "true" | "false" ? boolean : T;

type ConfigVariants<V extends ConfigSchema> = {
  [Variant in keyof V]?: StringToBoolean<keyof V[Variant]> | null | undefined;
};

type ClassProp = { class?: ClassValue; className?: ClassValue };

export type VariantProps<Component extends (...args: never[]) => unknown> = Omit<
  NonNullable<Parameters<Component>[0]>,
  "class" | "className"
>;

export declare function cva<V extends ConfigSchema>(
  base: ClassValue,
  config: {
    variants: V;
    defaultVariants?: ConfigVariants<V>;
    compoundVariants?: (ConfigVariants<V> & ClassProp)[];
  },
): (props?: ConfigVariants<V> & ClassProp) => string;

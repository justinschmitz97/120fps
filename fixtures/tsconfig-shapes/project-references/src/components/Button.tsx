import { cx, type ButtonBaseProps } from "@/lib/utils";

export interface ButtonProps extends ButtonBaseProps {
  label: string;
}

export default function Button({ label, variant, disabled }: ButtonProps) {
  return (
    <button className={cx("btn", variant ?? "solid")} disabled={disabled}>
      {label}
    </button>
  );
}

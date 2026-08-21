// excalidraw's DialogSize: a numeric branch beside three string literals.
export interface ConfirmDialogProps {
  size?: number | "small" | "regular" | "wide";
  title?: string;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  return <div data-size={String(props.size)}>{props.title}</div>;
}

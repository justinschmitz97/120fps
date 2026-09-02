export interface ConfirmDialogProps {
  title: string;
  confirmLabel?: string;
  cancelLabel?: string;
  isOpen?: boolean;
}

export function ConfirmDialog({ title, confirmLabel, cancelLabel }: ConfirmDialogProps) {
  return (
    <div>
      {title}
      <button>{confirmLabel}</button>
      <button>{cancelLabel}</button>
    </div>
  );
}

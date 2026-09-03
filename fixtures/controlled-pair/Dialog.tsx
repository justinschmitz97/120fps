interface DialogProps {
  // The controlled member of the pair.
  open?: boolean;
  // The uncontrolled twin: setting both in one cell is what
  // `useControllableState` rejects.
  defaultOpen?: boolean;
  // Required, so it keeps false and true.
  modal: boolean;
  size?: "small" | "large";
}

export function Dialog({ open, defaultOpen, modal, size }: DialogProps) {
  return (
    <div data-open={String(open ?? defaultOpen ?? false)} data-modal={String(modal)}>
      {size}
    </div>
  );
}

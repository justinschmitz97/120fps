interface DialogDefaultsProps {
  // The controlled member of the pair.
  open?: boolean;
  // The uncontrolled twin, with a default the component declares: the default
  // is what makes it look like a prop worth pinning in every cell.
  defaultOpen?: boolean;
  // Defaulted to true, so `true` is the state the component already renders
  // when the prop is absent.
  unmountOnClose?: boolean;
  modal: boolean;
}

export function DialogDefaults({
  open,
  defaultOpen = false,
  unmountOnClose = true,
  modal,
}: DialogDefaultsProps) {
  return (
    <div data-open={String(open ?? defaultOpen)} data-modal={String(modal)}>
      {String(unmountOnClose)}
    </div>
  );
}

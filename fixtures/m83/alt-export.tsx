import React from "react";

// M83 #8 (chakra-ui-F7 shape): the default export's required prop cannot be
// synthesized (a class instance, no synthesizable shape), but a named
// sibling export in the same file needs nothing but ordinary values.
class Store {
  private state = 0;
  read(): number {
    return this.state;
  }
}

interface DefaultProps {
  store: Store;
  label: string;
}

export default function AltExportDefault({ store, label }: DefaultProps) {
  return (
    <div>
      {label}: {store.read()}
    </div>
  );
}

interface NamedProps {
  label: string;
  disabled?: boolean;
}

export function AltExportNamed({ label, disabled }: NamedProps) {
  return <button disabled={disabled}>{label}</button>;
}

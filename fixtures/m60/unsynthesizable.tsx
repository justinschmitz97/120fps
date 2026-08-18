import React from "react";

class Store {
  private state = 0;
  read(): number {
    return this.state;
  }
}

interface OpaqueProps {
  store: Store;
  pending: Promise<string>;
  label: string;
}

export function StoreView({ store, pending, label }: OpaqueProps) {
  return (
    <div data-pending={String(pending)}>
      {label}: {store.read()}
    </div>
  );
}

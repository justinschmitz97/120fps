// chakra's shape: the resolved export takes a class instance no synthesizer can
// build, while a sibling export in the same file takes only plain props.
export class ListCollection<T> {
  constructor(private readonly items: T[]) {}
  at(index: number): T | undefined {
    return this.items[index];
  }
}

export interface SelectRootProviderProps {
  collection: ListCollection<string>;
  children?: string;
}

export function SelectRootProvider(props: SelectRootProviderProps) {
  return <div>{props.children}</div>;
}

export interface SelectTriggerProps {
  label: string;
  disabled?: boolean;
}

export function SelectTrigger(props: SelectTriggerProps) {
  return <button disabled={props.disabled}>{props.label}</button>;
}

export default SelectRootProvider;

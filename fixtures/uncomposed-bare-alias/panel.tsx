// M112 C3 (radix-themes-F3): radix's dual shape. The root is exported under a
// bare alias while its parts keep the family prefix, so `findRoot`'s prefix
// check finds no root and the run measures the bare export alone.
export interface PanelProps {
  size?: "1" | "2";
  children?: React.ReactNode;
}

export const Panel = (props: PanelProps) => <div data-size={props.size}>{props.children}</div>;

export const PanelRootHeader = (props: { children?: React.ReactNode }) => <header>{props.children}</header>;

export const PanelRootBody = (props: { children?: React.ReactNode }) => <section>{props.children}</section>;

// A dimension prop typed as a bare string renders as an SVG attribute the browser rejects.
export interface LoaderProps {
  size?: string;
  width?: string;
  strokeWidth?: string;
  label?: string;
  count?: number;
}

export function Loader(props: LoaderProps) {
  return <svg width={props.width} strokeWidth={props.strokeWidth} />;
}

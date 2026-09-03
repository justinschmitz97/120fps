export interface DrawerProps {
  heading: string;
  footer?: string;
  open?: boolean;
}

export default function Drawer({ heading, footer }: DrawerProps) {
  return (
    <div>
      {heading}
      <span>{footer}</span>
    </div>
  );
}

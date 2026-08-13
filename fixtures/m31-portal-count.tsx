import { createPortal } from "react-dom";

export interface PortalCountProps {
  open?: boolean;
}

// One element inside #root, three in a portal on document.body.
export function PortalCount({ open = true }: PortalCountProps) {
  return (
    <div data-part="anchor">
      {open
        ? createPortal(
            <div data-part="overlay">
              <p>body</p>
              <button type="button">close</button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export default PortalCount;

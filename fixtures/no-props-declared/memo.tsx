import { memo } from "react";

// The shape lobe-chat's Divider uses: a memoized parameterless render function.
export const Divider = memo(() => <hr className="divider" />);

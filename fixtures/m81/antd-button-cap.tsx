import React from "react";

// M81 section 2 + 1 interaction. A moderate, real (`Pick`-preserved, so still
// declared in `@types/react`) subset of `ButtonHTMLAttributes`'s DOM surface:
// large enough to exceed the 32-prop cap (so `warnPropCap` has real work to
// do), without pulling in every one of React's ~170 `on*`/`on*Capture` event
// handlers, which would make ANY single handler's stable-order position
// inside that oversized pool arbitrary. `onClick` is exactly the member
// ant-design-F3 named missing.
export interface ButtonProps
  extends Pick<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    | "disabled"
    | "hidden"
    | "autoFocus"
    | "spellCheck"
    | "draggable"
    | "formNoValidate"
    | "onClick"
    | "onChange"
    | "onFocus"
    | "onBlur"
    | "onKeyDown"
    | "onMouseEnter"
    | "className"
    | "id"
    | "title"
    | "lang"
    | "dir"
    | "tabIndex"
    | "style"
    | "role"
    | "slot"
    | "accessKey"
    | "inputMode"
    | "name"
    | "value"
    | "form"
    | "formTarget"
    | "formAction"
    | "formMethod"
    | "formEncType"
    | "type"
    | "translate"
    | "contextMenu"
    | "nonce"
    | "defaultValue"
    | "defaultChecked"
    | "suppressContentEditableWarning"
    | "suppressHydrationWarning"
    | "popover"
    | "inert"
  > {
  danger?: boolean;
  loading?: boolean;
}

export function Button(props: ButtonProps) {
  return <button {...props} />;
}

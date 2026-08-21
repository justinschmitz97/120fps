import React from "react";

// M92 (ant-design Button.tsx:294, M86's own motivating case): `const Button =
// InternalButton as CompoundedButton` is an AsExpression wrapping a bare
// Identifier -- erased at runtime, so Button IS InternalButton, but neither
// extractFunctionFromInitializer nor identifierBehind previously looked past
// the assertion. InternalButton's own body references `props.onClick` (the
// Tier-0 source-reference signal), but onClick itself is inherited purely
// through ButtonHTMLAttributes with no local redeclaration, so without the
// alias being followed it loses the cap to Tier-3 DOM-event volume exactly
// like ant-design's real Button/Tag.
interface CompoundedButton {
  (props: React.ButtonHTMLAttributes<HTMLButtonElement>): React.ReactElement;
}

const InternalButton = (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => {
  props.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
  return <button {...props} />;
};

export const Button = InternalButton as CompoundedButton;

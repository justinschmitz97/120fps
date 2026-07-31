import React, { type ReactNode } from "react";
import "./wrap-theme.css";

document.documentElement.setAttribute("data-theme", "dark");

export default function WrapTheme({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

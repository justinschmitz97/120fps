import React from "react";
import { RichTextProvider } from "./rich-text-provider.js";

export default function Wrapper({ children }: { children: React.ReactNode }) {
  return <RichTextProvider>{children}</RichTextProvider>;
}

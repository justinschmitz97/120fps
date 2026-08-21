import React, { createContext, useContext } from "react";

interface RichTextValue {
  editable: boolean;
}

const RichTextContext = createContext<RichTextValue | null>(null);

export function RichTextProvider({ children }: { children: React.ReactNode }) {
  return <RichTextContext.Provider value={{ editable: true }}>{children}</RichTextContext.Provider>;
}

export function useRichTextContext(): RichTextValue {
  const value = useContext(RichTextContext);
  if (!value) throw new Error("useRichTextContext must be used within RichTextProvider");
  return value;
}

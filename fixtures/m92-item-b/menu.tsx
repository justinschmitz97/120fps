import React, { createContext, useContext } from "react";

interface MenuValue {
  open: boolean;
}

const MenuContext = createContext<MenuValue | null>(null);

export function MenuProvider({ children }: { children: React.ReactNode }) {
  return <MenuContext.Provider value={{ open: false }}>{children}</MenuContext.Provider>;
}

function useMenuContext(): MenuValue {
  const value = useContext(MenuContext);
  if (!value) throw new Error("Menu must be used within MenuProvider");
  return value;
}

export function Menu({ children }: { children: React.ReactNode }) {
  useMenuContext();
  return <>{children}</>;
}

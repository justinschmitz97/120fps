import React, { useContext } from "react";
import { ProjectContext } from "./context";

export default function Widget() {
  const label = useContext(ProjectContext);
  if (label === null) throw new Error("Widget requires ProjectContext");
  return (
    <div className="widget">
      <button type="button">{label}</button>
    </div>
  );
}

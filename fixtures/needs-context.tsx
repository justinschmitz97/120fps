import React, { useContext } from "react";
import { WrapContext } from "./wrap-context";

export default function NeedsContext() {
  const label = useContext(WrapContext);
  if (label === null) throw new Error("NeedsContext requires WrapContext");
  return <div className="needs-context">{label}</div>;
}

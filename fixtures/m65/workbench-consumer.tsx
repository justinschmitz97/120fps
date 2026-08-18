import React from "react";
import { useWorkbench } from "./workbench-store.js";

interface WorkbenchConsumerProps {
  label: string;
}

export function WorkbenchConsumer({ label }: WorkbenchConsumerProps) {
  const { scale } = useWorkbench();
  return <div style={{ zoom: scale }}>{label}</div>;
}

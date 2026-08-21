import React from "react";
import { DeepMiddle } from "./deep-middle.js";

export function DeepEntry({ label }: { label: string }) {
  return <DeepMiddle>{label}</DeepMiddle>;
}

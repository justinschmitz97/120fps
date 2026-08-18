import React from "react";
import { useTheme } from "./theme-store.js";

interface HealthyConsumerProps {
  label: string;
}

export function HealthyConsumer({ label }: HealthyConsumerProps) {
  const theme = useTheme();
  return <div data-theme={theme}>{label}</div>;
}

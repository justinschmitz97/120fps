import React from "react";
import "./with-css.css";

export interface AlertProps {
  message: string;
  type?: "success" | "error" | "warning";
}

export function Alert({ message, type = "success" }: AlertProps) {
  return <div className={`alert alert-${type}`}>{message}</div>;
}

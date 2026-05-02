import React from "react";

interface PrimaryBtnProps {
  label: string;
  size?: "sm" | "md" | "lg";
}

interface SecondaryBtnProps {
  text: string;
  outlined?: boolean;
}

export function PrimaryBtn({ label, size = "md" }: PrimaryBtnProps) {
  return <button type="button" className={`primary size-${size}`}>{label}</button>;
}

export function SecondaryBtn({ text, outlined = false }: SecondaryBtnProps) {
  return <button type="button" className={`secondary ${outlined ? "outlined" : ""}`}>{text}</button>;
}

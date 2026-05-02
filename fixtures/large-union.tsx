import React from "react";

type Country =
  | "US" | "CA" | "MX" | "BR" | "AR"
  | "GB" | "FR" | "DE" | "IT" | "ES"
  | "NL" | "BE" | "SE" | "NO" | "DK"
  | "JP" | "CN" | "KR" | "IN" | "AU"
  | "NZ" | "ZA";

interface FlagProps {
  country: Country;
  size?: "sm" | "md" | "lg";
}

export function Flag({ country, size = "md" }: FlagProps) {
  return <span className={`flag flag-${country} flag-${size}`}>{country}</span>;
}

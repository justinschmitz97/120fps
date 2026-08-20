import React from "react";

// M81 3d: commerce-F1. `currencyCode: string` synthesizes the generic
// placeholder "test", which is not a member of Intl.NumberFormat's accepted
// currency codes and crashes.
export interface PriceProps {
  currencyCode: string;
  locale?: string;
  amount: number;
}

export function Price(props: PriceProps) {
  const formatted = new Intl.NumberFormat(props.locale ?? "en-US", {
    style: "currency",
    currency: props.currencyCode,
  }).format(props.amount);
  return <span>{formatted}</span>;
}

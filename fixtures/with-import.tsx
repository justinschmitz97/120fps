import React from "react";
import { formatPrice, type Currency } from "./helpers";

export interface PriceTagProps {
  cents: number;
  currency?: Currency;
  bold?: boolean;
}

export function PriceTag({ cents, currency = "USD", bold = false }: PriceTagProps) {
  const formatted = formatPrice(cents);
  return (
    <span className={bold ? "font-bold" : ""}>
      {formatted} {currency}
    </span>
  );
}

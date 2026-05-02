export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export type Currency = "USD" | "EUR" | "GBP";

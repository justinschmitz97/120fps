export function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

// Type-7 quantile (the default of R and numpy), so the printed number
// reproduces in any standard tool. Below n≈20 it is dominated by the slowest
// sample and estimates no tail: see the glossary.
export function computeP95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const h = (sorted.length - 1) * 0.95;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

// Two coefficients of variation: `computeCV` divides the squared deviations by
// n-1, `computeCvPercent` by n. ADR 0005 item 4 keeps both names until a
// measurement shows the noise-probe thresholds hold under the sample formula.
export function computeCV(samples: number[]): number {
  if (samples.length <= 1) return 0;
  const n = samples.length;
  let sum = 0;
  for (const s of samples) sum += s;
  const mean = sum / n;
  const absMean = Math.abs(mean);
  if (absMean === 0) return 0;
  let variance = 0;
  for (const s of samples) variance += (s - mean) ** 2;
  // Sample variance: N measurements are a sample of the component's cost
  // distribution, not the population. The n divisor understates dispersion at
  // the sample counts this tool runs (n=3..10).
  variance /= n - 1;
  const stddev = Math.sqrt(variance);
  return (stddev / absMean) * 100;
}

export function computeCvPercent(samples: number[]): number {
  if (samples.length < 2) return 0;
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  if (mean <= 0) return 0;
  const variance =
    samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
  return (Math.sqrt(variance) / mean) * 100;
}

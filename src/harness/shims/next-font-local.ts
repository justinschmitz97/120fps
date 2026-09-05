// The harness runs no font build step; the page keeps the font it already rendered with.
export default function localFont(_options?: Record<string, unknown>) {
  return { className: "", variable: "", style: {} };
}

// A font loader is a build step the harness does not run, so the returned
// handle claims no font: the page keeps the one it already rendered with.
export default function localFont(_options?: Record<string, unknown>) {
  return { className: "", variable: "", style: {} };
}

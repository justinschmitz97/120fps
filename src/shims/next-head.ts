// Renders nothing: its children are document metadata, and rendering them
// inline would put <title>/<meta> in the body and move the measured layout.
export default function Head(_props: Record<string, unknown>) {
  return null;
}

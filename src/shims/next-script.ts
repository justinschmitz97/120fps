// Renders nothing: a real <script> would fetch and execute third-party code
// inside the window the measurement traces.
export default function Script(_props: Record<string, unknown>) {
  return null;
}

import { useEffect, useState } from "react";

// Fetches on mount and renders a fallback until the response lands. Tests stall
// the route so the request is still in flight when the sample window closes.
export function FetchOnMount() {
  const [data, setData] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/m40-stall")
      .then((r) => r.text())
      .then((t) => {
        if (live) setData(t);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return <div data-testid="body">{data ?? "loading"}</div>;
}

export default FetchOnMount;

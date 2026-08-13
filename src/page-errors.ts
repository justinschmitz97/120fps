import type { Page } from "playwright";

const BUFFER_CAP = 20;

export interface PageErrorCapture {
  errors: string[];
  summary(): string;
}

export function attachPageErrorCapture(page: Page): PageErrorCapture {
  // Retention is by distinct message: repeats of one noisy message must not
  // evict the one real error under it. `order` holds first-seen order,
  // `counts` the repeat count per distinct message; the cap applies to the
  // number of distinct entries, not raw events.
  const order: string[] = [];
  const counts = new Map<string, number>();
  let dropped = 0;

  const record = (message: string) => {
    const existing = counts.get(message);
    if (existing !== undefined) {
      counts.set(message, existing + 1);
      return;
    }
    if (counts.size >= BUFFER_CAP) {
      dropped++;
      return;
    }
    counts.set(message, 1);
    order.push(message);
  };

  page.on("pageerror", (err) => record(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") record(msg.text());
  });

  const renderedErrors = (): string[] =>
    order.map((message) => {
      const count = counts.get(message)!;
      return count > 1 ? `${message} (×${count})` : message;
    });

  return {
    get errors(): string[] {
      return renderedErrors();
    },
    summary() {
      const lines = renderedErrors().map((e) => `  - ${e}`);
      if (dropped > 0) lines.push(`  (+${dropped} more dropped)`);
      return lines.join("\n");
    },
  };
}

export function enrichTimeoutError(
  err: unknown,
  capture: PageErrorCapture,
  context: string,
): Error {
  const base = err instanceof Error ? err : new Error(String(err));
  const isTimeout = base.name === "TimeoutError" || base.message.includes("Timeout");
  if (!isTimeout) return base;

  const detail = capture.errors.length > 0
    ? ` Page errors:\n${capture.summary()}`
    : " No page errors were captured.";
  return new Error(`${context} did not become ready within timeout.${detail}`, { cause: err });
}

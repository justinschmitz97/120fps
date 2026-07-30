import type { Page } from "playwright";

const BUFFER_CAP = 20;

export interface PageErrorCapture {
  errors: string[];
  summary(): string;
}

export function attachPageErrorCapture(page: Page): PageErrorCapture {
  const errors: string[] = [];
  let dropped = 0;

  const record = (message: string) => {
    if (errors.length >= BUFFER_CAP) {
      dropped++;
      return;
    }
    errors.push(message);
  };

  page.on("pageerror", (err) => record(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") record(msg.text());
  });

  return {
    errors,
    summary() {
      const lines = errors.map((e) => `  - ${e}`);
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

import type { Page } from "playwright";
import type { HarnessResult } from "../harness/index.js";

export const FONT_SETTLE_TIMEOUT_MS = 5000;
export const FONT_SETTLE_WARNING = "font loading did not settle within 5s";

export const FONT_LOAD_FAILED_WARNING = (families: string[]): string =>
  `font-face failed to load: ${families.join(", ")}; the measured metrics reflect the fallback font.`;

export interface FontSettleResult {
  settled: boolean;
  failedFamilies: string[];
}

type StyledHarness = Pick<HarnessResult, "cssFiles" | "wrapRelative">;

// A wrapper module imports styles at evaluation time just like --css, so both arm the gate.
export function needsStyleSettle(harness: StyledHarness): boolean {
  return (harness.cssFiles?.length ?? 0) > 0 || harness.wrapRelative !== undefined;
}

// Call before calibration and warmup, or the first measurement absorbs font and style cost.
export async function settleStyles(
  page: Page,
  harness: StyledHarness,
): Promise<FontSettleResult> {
  if (!needsStyleSettle(harness)) return { settled: true, failedFamilies: [] };
  return page.evaluate(async (timeoutMs: number) => {
    const fonts = (
      document as unknown as {
        fonts?: { ready?: Promise<unknown> } & Iterable<{ status?: string; family?: string }>;
      }
    ).fonts;
    let settled = true;
    if (fonts?.ready) {
      settled = await Promise.race([
        fonts.ready.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]);
    }
    document.body.getBoundingClientRect();
    // Bounded like rafFence: under begin-frame control a dead pump would hang this fence.
    await new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("frame starvation: style settle fence exceeded 10000ms")),
        10_000,
      );
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          clearTimeout(t);
          resolve(undefined);
        }),
      );
    });
    // fonts.ready resolves for errored faces too, so a fallback-font run needs its own signal.
    const failedFamilies: string[] = [];
    if (fonts) {
      for (const face of fonts) {
        if (face.status === "error" && typeof face.family === "string") {
          failedFamilies.push(face.family);
        }
      }
    }
    return { settled, failedFamilies: [...new Set(failedFamilies)] };
  }, FONT_SETTLE_TIMEOUT_MS);
}

// One wording for every phase: callers route a settle failure here instead of writing their own.
export function reportFontSettle(
  result: FontSettleResult,
  onWarning?: (warning: string) => void,
): void {
  if (!result.settled) onWarning?.(FONT_SETTLE_WARNING);
  if (result.failedFamilies.length > 0) onWarning?.(FONT_LOAD_FAILED_WARNING(result.failedFamilies));
}

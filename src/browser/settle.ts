import type { Page } from "playwright";
import type { HarnessResult } from "../harness/index.js";

export const FONT_SETTLE_TIMEOUT_MS = 5000;
export const FONT_SETTLE_WARNING = "font loading did not settle within 5s";

// document.fonts.ready resolves once every FontFace has *settled*
// (loaded or errored), not once every one has *loaded*: a 404'd or
// decode-failed @font-face still lets `ready` resolve, so the fallback-font
// metrics it produces need their own signal.
export const FONT_LOAD_FAILED_WARNING = (families: string[]): string =>
  `font-face failed to load: ${families.join(", ")}; the measured metrics reflect the fallback font.`;

export interface FontSettleResult {
  settled: boolean;
  failedFamilies: string[];
}

type StyledHarness = Pick<HarnessResult, "cssFiles" | "wrapRelative">;

// A wrapper module imports stylesheets and fonts at module evaluation time just
// like --css does, so both arm the gate.
export function needsStyleSettle(harness: StyledHarness): boolean {
  return (harness.cssFiles?.length ?? 0) > 0 || harness.wrapRelative !== undefined;
}

// Runs after window.__120fps exists and before any calibration, warmup, or
// sample, so the first measurement does not absorb font and stylesheet
// application cost. Returns false when fonts did not settle within the bound.
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
    // Bounded like rafFence: in a begin-frame-controlled browser a dead pump
    // would otherwise hang this fence forever.
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
    // fonts.ready resolves once every face has settled, loaded or errored: a
    // 404'd or decode-failed @font-face still lets it resolve, so a fallback
    // font measurement needs its own signal instead of reading as success.
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

// One wording, one place it is spelled: every phase that calls settleStyles
// and wants its failure surfaced routes through here instead of inventing its
// own message.
export function reportFontSettle(
  result: FontSettleResult,
  onWarning?: (warning: string) => void,
): void {
  if (!result.settled) onWarning?.(FONT_SETTLE_WARNING);
  if (result.failedFamilies.length > 0) onWarning?.(FONT_LOAD_FAILED_WARNING(result.failedFamilies));
}

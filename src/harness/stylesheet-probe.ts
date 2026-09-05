// The harness entry imports the chosen stylesheet first, so a sheet that fails or hangs takes the
// whole run down as "harness did not become ready" with nothing to read. Compiling each sheet once
// before the page is opened turns that into the disclosure the harness already has for an unstyled
// component. The page reads the same module from Vite's graph afterwards, so nothing is compiled
// twice.

export const CSS_COMPILE_TIMEOUT_MS = 20_000;

export function CSS_COMPILE_FAILED_WARNING(relative: string, detail: string): string {
  return (
    `${relative} did not compile (${detail}); the stylesheet was not injected and the component ` +
    "may render unstyled. Pass --css to name a stylesheet that compiles, or --no-css to measure " +
    "without one"
  );
}

export function CSS_COMPILE_TIMEOUT_WARNING(relative: string, milliseconds: number): string {
  return (
    `${relative} did not compile within ${Math.round(milliseconds / 1000)} s; the stylesheet was ` +
    "not injected and the component may render unstyled. Pass --css to name a stylesheet that " +
    "compiles, or --no-css to measure without one"
  );
}

export interface InjectedStylesheet {
  specifier: string;
  label: string;
}

export interface StylesheetProbe {
  kept: string[];
  warnings: string[];
}

// Vite's own message carries a stack; only its first line says what the compiler refused.
function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0].trim();
}

interface StylesheetCompiler {
  transformRequest(url: string): Promise<unknown>;
}

export async function probeInjectedStylesheets(
  server: StylesheetCompiler,
  sheets: readonly InjectedStylesheet[],
  timeoutMs: number = CSS_COMPILE_TIMEOUT_MS,
): Promise<StylesheetProbe> {
  const kept: string[] = [];
  const warnings: string[] = [];
  for (const sheet of sheets) {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = Symbol("timeout");
    // The transform stays pending on a timeout; the rejection handler keeps it from surfacing later.
    const compile = server.transformRequest(sheet.specifier);
    compile.catch(() => undefined);
    try {
      const outcome = await Promise.race([
        compile,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(timedOut), timeoutMs);
        }),
      ]);
      if (outcome === timedOut) {
        warnings.push(CSS_COMPILE_TIMEOUT_WARNING(sheet.label, timeoutMs));
        continue;
      }
      kept.push(sheet.specifier);
    } catch (err) {
      warnings.push(CSS_COMPILE_FAILED_WARNING(sheet.label, firstLine(err)));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return { kept, warnings };
}

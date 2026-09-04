// `runPreflight` sets this when it reports an import-cycle hit and clears it
// when it walks a graph without one; a --no-preflight run leaves it unset.
// `page-errors.ts` reads it to decide whether a page error can be blamed on
// the cycle.
let importCycleReported = false;

export function setImportCycleReported(reported: boolean): void {
  importCycleReported = reported;
}

export function wasImportCycleReported(): boolean {
  return importCycleReported;
}

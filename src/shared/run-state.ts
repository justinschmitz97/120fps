// Review A3: the note used to assert a cycle it never checked, and to
// cross-reference a warning that need not have been printed (a --no-preflight
// run prints none at all). `runPreflight` sets this when it actually reports an
// import-cycle hit, and clears it when it walks a graph without one.
let importCycleReported = false;

export function setImportCycleReported(reported: boolean): void {
  importCycleReported = reported;
}

export function wasImportCycleReported(): boolean {
  return importCycleReported;
}

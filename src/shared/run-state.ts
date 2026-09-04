// Reset at the top of every preflight walk and set when that walk finds an
// import cycle; the walk runs regardless of --no-preflight, which only
// changes whether a hard hit throws or becomes a warning. `page-errors.ts`
// reads it to decide whether a later page error can be blamed on the cycle.
let importCycleReported = false;

export function setImportCycleReported(reported: boolean): void {
  importCycleReported = reported;
}

export function wasImportCycleReported(): boolean {
  return importCycleReported;
}

// Set by the preflight walk, which runs even under --no-preflight; read by page-errors.ts.
let importCycleReported = false;

export function setImportCycleReported(reported: boolean): void {
  importCycleReported = reported;
}

export function wasImportCycleReported(): boolean {
  return importCycleReported;
}

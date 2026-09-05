const noop = () => {};

export function cookies() {
  return { get: () => undefined, getAll: () => [], set: noop, delete: noop, has: () => false };
}

export function headers() { return new Headers(); }

// Sync like cookies()/headers() above; draft mode is never active in a measurement.
export function draftMode() {
  return { isEnabled: false, enable: noop, disable: noop };
}

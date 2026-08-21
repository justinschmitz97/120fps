const noop = () => {};

export function cookies() {
  return { get: () => undefined, getAll: () => [], set: noop, delete: noop, has: () => false };
}

export function headers() { return new Headers(); }

// M96 (audit-found gap): matches the sync convention this file's own
// cookies()/headers() already use — draft mode is never active in a
// measurement.
export function draftMode() {
  return { isEnabled: false, enable: noop, disable: noop };
}

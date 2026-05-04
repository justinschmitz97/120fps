const noop = () => {};

export function cookies() {
  return { get: () => undefined, getAll: () => [], set: noop, delete: noop, has: () => false };
}

export function headers() { return new Headers(); }

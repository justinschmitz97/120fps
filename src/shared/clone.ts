// Date and RegExp: all synthesis produces. A class instance is a value; not cloned.
export function cloneDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneDeep);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value && typeof value === "object" && value.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = cloneDeep(v);
    }
    return out;
  }
  return value;
}

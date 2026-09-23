// Canonical JSON: one exact text for one value. Keys are sorted and there is
// no whitespace, so the same content always gives the same bytes, and so the
// same hash. Plain JSON.stringify keeps insertion order: {a,b} and {b,a}
// would hash differently even though they mean the same thing.

export function canonical(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`cannot store the number ${v}`);
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  throw new Error(`cannot store a value of type ${typeof v}`);
}

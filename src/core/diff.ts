// Level 1 diff: which clips were added, removed or modified, and for modified
// clips, which field groups changed. A field group is one editing intent:
// in and out change together when you trim, so they are one group.

import type { Clip, Timeline } from './timeline.ts';

export type Group = 'placement' | 'trim' | 'source' | 'effects' | `prop:${string}`;

export type ClipChange =
  | { kind: 'added'; id: string; after: Clip }
  | { kind: 'removed'; id: string; before: Clip }
  | { kind: 'modified'; id: string; before: Clip; after: Clip; groups: Group[] };

/** The fields a group covers. Merge copies whole groups, never single fields. */
export function groupValue(c: Clip, g: Group): unknown {
  switch (g) {
    case 'placement': return [c.track, c.start];
    case 'trim': return [c.in, c.out];
    case 'source': return c.source;
    case 'effects': return c.effects;
    default: return c.props[g.slice(5)];
  }
}

/** Returns `c` with group `g` taken from `from`. */
export function withGroup(c: Clip, g: Group, from: Clip): Clip {
  switch (g) {
    case 'placement': return { ...c, track: from.track, start: from.start };
    case 'trim': return { ...c, in: from.in, out: from.out };
    case 'source': return { ...c, source: from.source };
    case 'effects': return { ...c, effects: [...from.effects] };
    default: {
      const key = g.slice(5);
      const props = { ...c.props };
      if (key in from.props) props[key] = from.props[key];
      else delete props[key];
      return { ...c, props };
    }
  }
}

export function sameGroup(a: Clip, b: Clip, g: Group): boolean {
  switch (g) {
    case 'placement': return a.track === b.track && a.start === b.start;
    case 'trim': return a.in === b.in && a.out === b.out;
    case 'source': return a.source === b.source;
    // Order matters: effects run as a chain, so [blur, grain] is not [grain, blur].
    case 'effects': return a.effects.length === b.effects.length && a.effects.every((e, i) => e === b.effects[i]);
    default: {
      const key = g.slice(5);
      return (key in a.props) === (key in b.props) && a.props[key] === b.props[key];
    }
  }
}

export function allGroups(...clips: Clip[]): Group[] {
  const keys = new Set<string>();
  for (const c of clips) for (const k of Object.keys(c.props)) keys.add(k);
  return ['placement', 'trim', 'source', 'effects', ...[...keys].sort().map((k) => `prop:${k}` as Group)];
}

export function changedGroups(a: Clip, b: Clip): Group[] {
  if (a === b) return [];
  return allGroups(a, b).filter((g) => !sameGroup(a, b, g));
}

/** Matches clips by id. Sorted by id so the output is the same every time. */
export function diff(before: Timeline, after: Timeline): ClipChange[] {
  const out: ClipChange[] = [];
  // for-in, not Object.entries: on 20,000 clips entries() builds 20,000 small arrays and is ~3x slower.
  for (const id in before.clips) {
    const b = before.clips[id];
    const a = after.clips[id];
    if (!a) out.push({ kind: 'removed', id, before: b });
    else if (a !== b) {
      // a === b is the common case: unchanged clips are shared objects, so we skip them for free.
      const groups = changedGroups(b, a);
      if (groups.length) out.push({ kind: 'modified', id, before: b, after: a, groups });
    }
  }
  for (const id in after.clips) {
    const a = after.clips[id];
    if (!before.clips[id]) out.push({ kind: 'added', id, after: a });
  }
  return out.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

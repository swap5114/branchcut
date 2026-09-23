// The data model. We version the edit decision list, never the pixels:
// a clip only says "play frames in..out of media X at timeline frame start".

/** A whole frame number. Never a float: see DECISIONS.md, Phase 1. */
export type Frame = number;

export type TrackKind = 'video' | 'audio' | 'text';

export interface Track {
  id: string;
  name: string;
  kind: TrackKind;
  /** true = this track moves when a ripple edit happens on another track. */
  syncLock: boolean;
}

export type PropValue = string | number | boolean;

export interface Clip {
  /** Stable for the clip's whole life. Diff and merge match clips by this id. */
  id: string;
  track: string;
  /** Timeline frame where the clip begins. */
  start: Frame;
  /** Media id, or "text" for titles. */
  source: string;
  /** Source frames. The clip plays source[in, out), so duration = out - in. */
  in: Frame;
  out: Frame;
  props: Record<string, PropValue>;
  effects: string[];
}

export interface Timeline {
  fps: number;
  /** In display order, top to bottom. */
  tracks: Track[];
  /** Keyed by clip id, not stored as an array: position in a list is not identity. */
  clips: Record<string, Clip>;
}

export const duration = (c: Clip): Frame => c.out - c.in;
export const end = (c: Clip): Frame => c.start + duration(c);

export function getClip(tl: Timeline, id: string): Clip {
  const c = tl.clips[id];
  if (!c) throw new Error(`clip ${id}: not found`);
  return c;
}

export function getTrack(tl: Timeline, id: string): Track {
  const t = tl.tracks.find((t) => t.id === id);
  if (!t) throw new Error(`track ${id}: not found`);
  return t;
}

/** Clips on one track, sorted by start. */
export function clipsOnTrack(tl: Timeline, trackId: string): Clip[] {
  return Object.values(tl.clips)
    .filter((c) => c.track === trackId)
    .sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
}

/** Throws a clear message if a clip's own fields are wrong. */
export function checkClip(tl: Timeline, c: Clip): void {
  const bad = (msg: string) => {
    throw new Error(`clip ${c.id}: ${msg}`);
  };
  if (typeof c.id !== 'string' || c.id === '') bad('id must be a non-empty string');
  for (const k of ['start', 'in', 'out'] as const) {
    if (!Number.isInteger(c[k])) bad(`${k} must be a whole frame number`);
  }
  if (c.start < 0) bad('start must be 0 or more');
  if (c.in < 0) bad('in must be 0 or more');
  if (c.out <= c.in) bad('out must be after in');
  if (!tl.tracks.some((t) => t.id === c.track)) bad(`track ${c.track} does not exist`);
  if (typeof c.source !== 'string' || c.source === '') bad('source must be a non-empty string');
  if (!Array.isArray(c.effects) || c.effects.some((e) => typeof e !== 'string')) {
    bad('effects must be a list of strings');
  }
  if (new Set(c.effects).size !== c.effects.length) bad('effects must not repeat');
  if (typeof c.props !== 'object' || c.props === null || Array.isArray(c.props)) {
    bad('props must be an object');
  }
}

/** Every track's clips, sorted by start, in one pass over the clips. */
export function byTrack(tl: Timeline): Map<string, Clip[]> {
  const out = new Map<string, Clip[]>(tl.tracks.map((t) => [t.id, []]));
  for (const c of Object.values(tl.clips)) {
    let list = out.get(c.track);
    if (!list) out.set(c.track, (list = []));
    list.push(c);
  }
  for (const list of out.values()) list.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  return out;
}

/**
 * Two clips on the same track may not overlap. Every edit keeps this true,
 * so the merge can say "this overlap is new" and ask about it.
 */
export function findOverlap(tl: Timeline, trackId: string, list = clipsOnTrack(tl, trackId)): [Clip, Clip] | null {
  for (let i = 1; i < list.length; i++) {
    if (list[i].start < end(list[i - 1])) return [list[i - 1], list[i]];
  }
  return null;
}

/** The first clip that overlaps `c` on its track. One pass, no sorting: for one-clip edits. */
export function overlapWith(tl: Timeline, c: Clip): Clip | null {
  const e = end(c);
  for (const x of Object.values(tl.clips)) {
    if (x.track === c.track && x.id !== c.id && x.start < e && c.start < end(x)) return x;
  }
  return null;
}

export function checkTimeline(tl: Timeline): void {
  if (!Number.isInteger(tl.fps) || tl.fps <= 0) throw new Error('fps must be a whole number above 0');
  const trackIds = new Set<string>();
  for (const t of tl.tracks) {
    if (trackIds.has(t.id)) throw new Error(`track ${t.id}: id is used twice`);
    trackIds.add(t.id);
  }
  for (const [key, c] of Object.entries(tl.clips)) {
    if (c.id !== key) throw new Error(`clip ${key}: stored under a different id (${c.id})`);
    checkClip(tl, c);
  }
  for (const [track, list] of byTrack(tl)) {
    const o = findOverlap(tl, track, list);
    if (o) throw new Error(`clip ${o[1].id}: overlaps ${o[0].id} on track ${track}`);
  }
}

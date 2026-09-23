// Editing operations. Each one returns a NEW timeline and never changes the old one.
// Old versions must stay valid: the repo keeps them, the diff compares them,
// and unchanged clips are shared between versions instead of copied.

import {
  type Clip, type Frame, type PropValue, type Timeline,
  byTrack, checkClip, duration, end, findOverlap, getClip, getTrack, overlapWith,
} from './timeline.ts';

function withClips(tl: Timeline, clips: Record<string, Clip>, touchedTracks: Iterable<string>): Timeline {
  const next = { ...tl, clips };
  const lists = byTrack(next);
  for (const t of new Set(touchedTracks)) {
    const o = findOverlap(next, t, lists.get(t));
    if (o) throw new Error(`clip ${o[1].id}: would overlap ${o[0].id} on track ${t}`);
  }
  return next;
}

/** A one-clip edit: only that clip can have made a new overlap, so only it is checked. */
function replace(tl: Timeline, clip: Clip): Timeline {
  checkClip(tl, clip);
  const next = { ...tl, clips: { ...tl.clips, [clip.id]: clip } };
  const o = overlapWith(next, clip);
  if (o) throw new Error(`clip ${clip.id}: would overlap ${o.id} on track ${clip.track}`);
  return next;
}

function frames(n: number, what: string): Frame {
  if (!Number.isInteger(n)) throw new Error(`${what} must be a whole frame number`);
  return n;
}

export function addClip(tl: Timeline, clip: Clip): Timeline {
  if (tl.clips[clip.id]) throw new Error(`clip ${clip.id}: id already exists`);
  return replace(tl, { ...clip, props: { ...clip.props }, effects: [...clip.effects] });
}

/** Removes the clip and leaves a gap. Nothing else moves. */
export function deleteClip(tl: Timeline, id: string): Timeline {
  getClip(tl, id);
  const { [id]: _gone, ...rest } = tl.clips;
  return { ...tl, clips: rest };
}

export function moveClip(tl: Timeline, id: string, start: Frame, track?: string): Timeline {
  const c = getClip(tl, id);
  const to = track ?? c.track;
  if (getTrack(tl, to).kind !== getTrack(tl, c.track).kind) {
    throw new Error(`clip ${id}: cannot move to a ${getTrack(tl, to).kind} track`);
  }
  return replace(tl, { ...c, start: frames(start, 'start'), track: to });
}

/** value = null removes the property. */
export function setProp(tl: Timeline, id: string, key: string, value: PropValue | null): Timeline {
  const c = getClip(tl, id);
  const props = { ...c.props };
  if (value === null) delete props[key];
  else props[key] = value;
  return replace(tl, { ...c, props });
}

export function toggleEffect(tl: Timeline, id: string, effect: string): Timeline {
  const c = getClip(tl, id);
  const effects = c.effects.includes(effect)
    ? c.effects.filter((e) => e !== effect)
    : [...c.effects, effect];
  return replace(tl, { ...c, effects });
}

/** Moves the clip's end by `by` frames (positive = shorter). Leaves a gap. */
export function trimEnd(tl: Timeline, id: string, by: Frame): Timeline {
  const c = getClip(tl, id);
  return replace(tl, { ...c, out: c.out - frames(by, 'trim amount') });
}

/**
 * Removes the time range [from, to) from the given tracks.
 * Inside → removed. After → slides left. Crossing an edge → trimmed.
 * A clip covering the whole range gets shorter by the range length; we do not
 * split it, because a split would invent a new clip id as a side effect.
 */
function removeRange(tl: Timeline, from: Frame, to: Frame, tracks: Set<string>): Record<string, Clip> {
  const len = to - from;
  const clips: Record<string, Clip> = {};
  for (const c of Object.values(tl.clips)) {
    const s = c.start;
    const e = end(c);
    if (!tracks.has(c.track) || e <= from) clips[c.id] = c;
    else if (s >= to) clips[c.id] = { ...c, start: s - len };
    else if (s >= from && e <= to) continue;
    else if (s < from && e > to) clips[c.id] = { ...c, out: c.out - len };
    else if (s < from) clips[c.id] = { ...c, out: c.out - (e - from) };
    else clips[c.id] = { ...c, start: from, in: c.in + (to - s) };
  }
  return clips;
}

/** The clip's own track always ripples. Other tracks ripple only if sync-locked. */
function rippleTracks(tl: Timeline, ownTrack: string): Set<string> {
  return new Set([ownTrack, ...tl.tracks.filter((t) => t.syncLock).map((t) => t.id)]);
}

/** Shortens a clip by `by` frames and pulls everything after it left. */
export function rippleTrimEnd(tl: Timeline, id: string, by: Frame): Timeline {
  const c = getClip(tl, id);
  frames(by, 'trim amount');
  if (by <= 0) throw new Error(`clip ${id}: ripple trim amount must be above 0`);
  if (by >= duration(c)) throw new Error(`clip ${id}: out must be after in`);
  const trimmed = trimEnd(tl, id, by);
  const tracks = rippleTracks(tl, c.track);
  // The clip already ends at the new end, so removing the freed range
  // only slides (or trims) what comes after it.
  return withClips(trimmed, removeRange(trimmed, end(c) - by, end(c), tracks), tracks);
}

/** Removes the clip's time range from its own track and every sync-locked track. */
export function rippleDelete(tl: Timeline, id: string): Timeline {
  const c = getClip(tl, id);
  const tracks = rippleTracks(tl, c.track);
  return withClips(tl, removeRange(tl, c.start, end(c), tracks), tracks);
}

/**
 * Splits at timeline frame `at`. The left part keeps the id (it is the
 * "same" clip, so edits to it on another branch still apply). The right part
 * gets a new id built from the source frame of the cut: two branches that
 * make the same cut get the same id, and a ripple does not change it.
 */
export function split(tl: Timeline, id: string, at: Frame, newId?: string): Timeline {
  const c = getClip(tl, id);
  frames(at, 'split point');
  if (at <= c.start || at >= end(c)) throw new Error(`clip ${id}: split point must be inside the clip`);
  const cut = c.in + (at - c.start);
  const rightId = newId ?? `${id}@${cut}`;
  if (tl.clips[rightId]) throw new Error(`clip ${rightId}: id already exists`);
  const left: Clip = { ...c, out: cut };
  const right: Clip = { ...c, id: rightId, start: at, in: cut, props: { ...c.props }, effects: [...c.effects] };
  return withClips(tl, { ...tl.clips, [id]: left, [rightId]: right }, [c.track]);
}


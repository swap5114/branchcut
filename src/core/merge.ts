// Three-way merge of timelines: base, ours, theirs → merged + conflicts + notes.
//
// Pass 1  field merge, clip by clip, group by group (ripple shifts add up)
// Pass 2  new clips keep their context (move with their closest anchor)
// Pass 3  time check: overlaps that neither branch had become conflicts
//
// Stateless: the caller sends the same inputs again with `choices`, keyed by
// conflict id, and gets a new result. Nothing is stored between calls.

import { type Group, allGroups, changedGroups, sameGroup, withGroup } from './diff.ts';
import { fmtShift, label, rippleShifts } from './intents.ts';
import { type Clip, type Frame, type Timeline, byTrack, clipsOnTrack, end } from './timeline.ts';

export type Side = 'ours' | 'theirs';
export type Origin = Side | 'both';

export type Conflict =
  | { id: string; kind: 'edit-edit'; clip: string; group: Group; options: string[] }
  | { id: string; kind: 'delete-edit'; clip: string; deletedBy: Side; edits: Group[]; options: string[] }
  | { id: string; kind: 'overlap'; track: string; clips: [string, string]; amount: Frame; options: string[] };

export type OverlapConflict = Extract<Conflict, { kind: 'overlap' }>;

export interface Note {
  text: string;
  clips: string[];
}

export interface MergeResult {
  timeline: Timeline;
  /** Still open. The timeline holds a default for each (ours / deleted / overlapping). */
  conflicts: Conflict[];
  /** Conflicts that a choice already settled. */
  resolved: { conflict: Conflict; choice: string }[];
  /** Plain sentences about what the merge decided by itself. */
  notes: Note[];
  /** Who really edited each merged clip. Ripple-only slides do not count. */
  origin: Record<string, Origin>;
}

export interface MergeOptions {
  choices?: Record<string, string>;
  names?: { ours: string; theirs: string };
}

const other = (s: Side): Side => (s === 'ours' ? 'theirs' : 'ours');

export function merge(base: Timeline, ours: Timeline, theirs: Timeline, opts: MergeOptions = {}): MergeResult {
  const choices = opts.choices ?? {};
  const names = opts.names ?? { ours: 'ours', theirs: 'theirs' };
  const side = { ours, theirs };
  const shifts = { ours: rippleShifts(base, ours), theirs: rippleShifts(base, theirs) };

  const clips: Record<string, Clip> = {};
  const conflicts: Conflict[] = [];
  const resolved: MergeResult['resolved'] = [];
  const notes: Note[] = [];
  const origin: Record<string, Origin> = {};

  /** Records the conflict and returns the choice to apply (or null = use the default). */
  const decide = (c: Conflict): string | null => {
    const choice = choices[c.id];
    if (choice === undefined) {
      conflicts.push(c);
      return null;
    }
    if (!c.options.includes(choice)) {
      throw new Error(`conflict ${c.id}: "${choice}" is not a valid choice (use ${c.options.join(' or ')})`);
    }
    resolved.push({ conflict: c, choice });
    return choice;
  };

  /** Changes that are more than a ripple sliding the clip along. */
  const realEdits = (s: Side, b: Clip, x: Clip): Group[] =>
    changedGroups(b, x).filter((g) => !(g === 'placement' && shifts[s].has(b.id)));

  // ---------- Pass 1: field merge ----------
  const rippleSums = new Map<Frame, string[]>();
  const ids = new Set([...Object.keys(base.clips), ...Object.keys(ours.clips), ...Object.keys(theirs.clips)]);

  for (const id of ids) {
    const b = base.clips[id];
    const o = ours.clips[id];
    const t = theirs.clips[id];

    if (!b) {
      // Added. If both sides added the same id (the same split), merge them group by group.
      if (o && t) {
        let m = o;
        for (const g of allGroups(o, t)) {
          if (sameGroup(o, t, g)) continue;
          const pick = decide({ id: `edit:${id}:${g}`, kind: 'edit-edit', clip: id, group: g, options: ['ours', 'theirs'] });
          if (pick === 'theirs') m = withGroup(m, g, t);
        }
        clips[id] = m;
        origin[id] = 'both';
      } else {
        clips[id] = (o ?? t)!;
        origin[id] = o ? 'ours' : 'theirs';
      }
      continue;
    }

    if (!o && !t) continue; // deleted on both sides

    if (!o || !t) {
      const deletedBy: Side = o ? 'theirs' : 'ours';
      const keptBy = other(deletedBy);
      const kept = (o ?? t)!;
      const edits = realEdits(keptBy, b, kept);
      if (edits.length === 0) {
        if (shifts[keptBy].has(id)) {
          notes.push({
            text: `Removed ${q(b)}: ${names[deletedBy]} deleted it, ${names[keptBy]} only moved it in a ripple`,
            clips: [id],
          });
        }
        continue;
      }
      const pick = decide({ id: `delete:${id}`, kind: 'delete-edit', clip: id, deletedBy, edits, options: ['delete', 'keep'] });
      if (pick === 'keep') {
        clips[id] = kept;
        origin[id] = keptBy;
      }
      continue;
    }

    // Present on both sides. Shared objects mean "unchanged", so most clips stop here.
    const oEdits = o === b ? [] : realEdits('ours', b, o);
    const tEdits = t === b ? [] : realEdits('theirs', b, t);
    if (oEdits.length && tEdits.length) origin[id] = 'both';
    else if (oEdits.length) origin[id] = 'ours';
    else if (tEdits.length) origin[id] = 'theirs';
    if (t === b) { clips[id] = o; continue; }
    if (o === b) { clips[id] = t; continue; }

    let m = b;
    for (const g of allGroups(b, o, t)) {
      const oc = !sameGroup(b, o, g);
      const tc = !sameGroup(b, t, g);
      if (!oc && !tc) continue;
      if (oc && !tc) m = withGroup(m, g, o);
      else if (!oc && tc) m = withGroup(m, g, t);
      else if (sameGroup(o, t, g)) m = withGroup(m, g, o);
      else if (
        g === 'placement' && o.track === b.track && t.track === b.track &&
        (shifts.ours.has(id) || shifts.theirs.has(id))
      ) {
        // Ripples add up: each side pulled the clip by the time it removed.
        const total = o.start - b.start + (t.start - b.start);
        m = { ...m, start: Math.max(0, b.start + total) };
        const list = rippleSums.get(total);
        if (list) list.push(id);
        else rippleSums.set(total, [id]);
      } else {
        const pick = decide({ id: `edit:${id}:${g}`, kind: 'edit-edit', clip: id, group: g, options: ['ours', 'theirs'] });
        m = withGroup(m, g, pick === 'theirs' ? t : o);
      }
    }
    clips[id] = m;
  }

  for (const [total, list] of rippleSums) {
    notes.push({ text: `Both ripples add up: ${plural(list.length)} moved ${fmtShift(total, base.fps)}`, clips: list });
  }

  // ---------- Pass 2: new clips keep their context ----------
  for (const [id, c] of Object.entries(clips)) {
    if (base.clips[id] || (ours.clips[id] && theirs.clips[id])) continue;
    const s: Side = ours.clips[id] ? 'ours' : 'theirs';
    const branch = side[s];
    const anchor = findAnchor(branch, branch.clips[id], (x) => !!base.clips[x] && !!clips[x]);
    if (!anchor) continue;
    const move = clips[anchor].start - branch.clips[anchor].start;
    if (move === 0) continue;
    clips[id] = { ...c, start: Math.max(0, c.start + move) };
    notes.push({
      text: `Moved new clip ${q(c)} ${fmtShift(move, base.fps)} to stay with ${q(clips[anchor])}`,
      clips: [id, anchor],
    });
  }

  // ---------- Pass 3: time check, then apply overlap choices ----------
  const timeline: Timeline = { fps: ours.fps, tracks: ours.tracks, clips };
  const applied = new Set<string>();
  // Each choice can create new overlaps (make-room pushes clips into others),
  // so we apply one choice at a time and check again.
  for (;;) {
    const found = newOverlaps(timeline, ours, theirs);
    const next = found.find((c) => choices[c.id] !== undefined && !applied.has(c.id));
    if (!next) {
      conflicts.push(...found);
      break;
    }
    applied.add(next.id);
    const choice = decide(next)!;
    if (choice === 'make-room') makeRoom(timeline, next);
    else {
      const dropped = choice.slice(5);
      delete clips[dropped];
      delete origin[dropped];
    }
  }

  return { timeline, conflicts, resolved, notes, origin };
}

/**
 * The closest clip that exists in the base and in the merged result:
 * a neighbour on the same track (distance = the gap), or a clip on another
 * sync-locked track that the new clip sits on top of (distance 0).
 * On a tie we prefer the clip underneath, lowest track first (the main story).
 */
export function findAnchor(branch: Timeline, c: Clip, usable: (id: string) => boolean): string | null {
  const trackIndex = new Map(branch.tracks.map((t, i) => [t.id, i]));
  const locked = new Set(branch.tracks.filter((t) => t.syncLock).map((t) => t.id));
  if (!locked.has(c.track)) return null;

  const cands: { id: string; dist: Frame; under: boolean; track: number }[] = [];
  const list = clipsOnTrack(branch, c.track);
  const i = list.findIndex((x) => x.id === c.id);
  for (let j = i - 1; j >= 0; j--) {
    if (usable(list[j].id)) { cands.push({ id: list[j].id, dist: c.start - end(list[j]), under: false, track: 0 }); break; }
  }
  for (let j = i + 1; j < list.length; j++) {
    if (usable(list[j].id)) { cands.push({ id: list[j].id, dist: list[j].start - end(c), under: false, track: 0 }); break; }
  }
  for (const x of Object.values(branch.clips)) {
    if (x.track === c.track || !locked.has(x.track) || !usable(x.id)) continue;
    if (x.start < end(c) && end(x) > c.start) cands.push({ id: x.id, dist: 0, under: true, track: trackIndex.get(x.track)! });
  }
  cands.sort((a, b) =>
    a.dist - b.dist || Number(b.under) - Number(a.under) || b.track - a.track || (a.id < b.id ? -1 : 1));
  return cands[0]?.id ?? null;
}

function overlapping(tl: Timeline, a: string, b: string): boolean {
  const x = tl.clips[a];
  const y = tl.clips[b];
  return !!x && !!y && x.track === y.track && x.start < end(y) && y.start < end(x);
}

/** Pairs on one track that overlap now, but overlapped in neither branch. */
export function newOverlaps(tl: Timeline, ours: Timeline, theirs: Timeline): OverlapConflict[] {
  const out: OverlapConflict[] = [];
  for (const [track, list] of byTrack(tl)) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length && list[j].start < end(list[i]); j++) {
        const [a, b] = [list[i], list[j]];
        if (overlapping(ours, a.id, b.id) || overlapping(theirs, a.id, b.id)) continue;
        const pair = [a.id, b.id].sort() as [string, string];
        out.push({
          id: `overlap:${track}:${pair.join(':')}`,
          kind: 'overlap',
          track,
          clips: [a.id, b.id], // earlier first
          amount: Math.min(end(a), end(b)) - b.start,
          options: ['make-room', `drop:${a.id}`, `drop:${b.id}`],
        });
      }
    }
  }
  return out;
}

/** Pushes the later clip, and everything after it on that track, right until the overlap is gone. */
function makeRoom(tl: Timeline, c: OverlapConflict): void {
  const [first, later] = c.clips.map((id) => tl.clips[id]);
  const push = end(first) - later.start;
  for (const x of clipsOnTrack(tl, c.track)) {
    if (x.id !== first.id && x.start >= later.start) tl.clips[x.id] = { ...x, start: x.start + push };
  }
}

const q = (c: Clip) => `"${label(c)}"`;
const plural = (n: number) => `${n} clip${n === 1 ? '' : 's'}`;

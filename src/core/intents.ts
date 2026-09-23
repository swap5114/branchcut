// Level 2 diff: turn clip changes into sentences an editor would say.
// We only look at two snapshots (before, after), never at a log of operations,
// so this works across many commits, after a merge, or for edits made by an agent.

import { type ClipChange, type Group, diff } from './diff.ts';
import { type Clip, type Frame, type Timeline, duration, end } from './timeline.ts';

export type IntentKind =
  | 'ripple' | 'split' | 'added' | 'removed' | 'moved' | 'trimmed' | 'source' | 'effects' | 'prop';

export interface Intent {
  kind: IntentKind;
  text: string;
  /** Every clip this sentence is about, so a UI can highlight them. */
  clips: string[];
  /** Timeline frame used to sort sentences left to right. */
  at: Frame;
}

export interface Ripple {
  /** Signed frames every moved clip slid by. */
  shift: Frame;
  moved: string[];
  cause: { kind: 'delete' | 'trim' | 'insert'; id: string } | null;
  /** Clips on other tracks removed because they sat inside the cut. */
  alsoRemoved: string[];
  /** Clips that crossed an edge of the cut and got trimmed by it. */
  alsoTrimmed: string[];
}

type Modified = Extract<ClipChange, { kind: 'modified' }>;
type Added = Extract<ClipChange, { kind: 'added' }>;
type Removed = Extract<ClipChange, { kind: 'removed' }>;

const isMod = (c: ClipChange): c is Modified => c.kind === 'modified';
const isAdd = (c: ClipChange): c is Added => c.kind === 'added';
const isRem = (c: ClipChange): c is Removed => c.kind === 'removed';

/** Signed change in length. Negative = the clip got shorter. */
const lengthChange = (m: Modified) => duration(m.after) - duration(m.before);

/**
 * A clip "slid" if its start moved on the same track, and the move is not
 * just a start-trim (in a start-trim, start and in move together and the
 * picture stays where it was).
 */
function slide(m: Modified): Frame | null {
  const ds = m.after.start - m.before.start;
  if (ds === 0 || m.after.track !== m.before.track) return null;
  if (ds === m.after.in - m.before.in) return null;
  return ds;
}

export function findRipples(before: Timeline, after: Timeline, changes = diff(before, after)): Ripple[] {
  const mods = changes.filter(isMod);
  const added = changes.filter(isAdd);
  const removed = changes.filter(isRem);

  // Edit sizes: how far a ripple caused by each edit would move the clips after it.
  const sizes = new Set<Frame>();
  for (const r of removed) sizes.add(-duration(r.before));
  for (const a of added) sizes.add(duration(a.after));
  for (const m of mods) if (lengthChange(m) !== 0) sizes.add(lengthChange(m));

  const slides = new Map<Frame, Modified[]>();
  for (const m of mods) {
    const s = slide(m);
    if (s === null) continue;
    const list = slides.get(s);
    if (list) list.push(m); // push, never copy: a ripple can move thousands of clips
    else slides.set(s, [m]);
  }

  const ripples: Ripple[] = [];
  const usedCause = new Set<string>();
  for (const [shift, group] of slides) {
    // A lone clip that slid by an amount no edit explains is a deliberate move.
    if (group.length < 2 && !sizes.has(shift)) continue;
    const firstMoved = group.reduce((min, m) => Math.min(min, m.before.start), Infinity);
    const movedIds = new Set(group.map((m) => m.id));

    let cause: Ripple['cause'] = null;
    let cut: [Frame, Frame] | null = null;
    // Several edits can have the right size (two 10s clips were removed, but only one
    // was a ripple). The cause is the one that ends closest before the clips that moved.
    const del = closest(removed.filter((r) => !usedCause.has(r.id) && -duration(r.before) === shift && end(r.before) <= firstMoved), (r) => end(r.before));
    const trim = closest(mods.filter((m) => !usedCause.has(m.id) && !movedIds.has(m.id) && lengthChange(m) === shift && end(m.before) <= firstMoved), (m) => end(m.before));
    const ins = closest(added.filter((a) => !usedCause.has(a.id) && duration(a.after) === shift && a.after.start <= firstMoved), (a) => a.after.start);
    if (del) {
      cause = { kind: 'delete', id: del.id };
      cut = [del.before.start, end(del.before)];
    } else if (trim) {
      cause = { kind: 'trim', id: trim.id };
      cut = [end(trim.after), end(trim.before)];
    } else if (ins) {
      cause = { kind: 'insert', id: ins.id };
    }
    if (cause) usedCause.add(cause.id);

    const alsoRemoved: string[] = [];
    const alsoTrimmed: string[] = [];
    if (cut) {
      const [from, to] = cut;
      for (const r of removed) {
        if (r.id !== cause?.id && r.before.start >= from && end(r.before) <= to) alsoRemoved.push(r.id);
      }
      for (const m of mods) {
        const s = m.before.start;
        const e = end(m.before);
        const crosses = s < to && e > from && !(s >= from && e <= to);
        if (crosses && m.id !== cause?.id && !movedIds.has(m.id) && lengthChange(m) < 0) alsoTrimmed.push(m.id);
      }
    }
    ripples.push({ shift, moved: [...movedIds], cause, alsoRemoved, alsoTrimmed });
  }
  return ripples;
}

/** The item with the largest position, i.e. the one nearest the clips that moved. */
function closest<T>(items: T[], pos: (x: T) => Frame): T | undefined {
  return items.reduce<T | undefined>((best, x) => (best === undefined || pos(x) > pos(best) ? x : best), undefined);
}

/** Clip id → shift, for every clip that only slid because of a ripple. The merge uses this. */
export function rippleShifts(before: Timeline, after: Timeline, changes = diff(before, after)): Map<string, Frame> {
  const out = new Map<string, Frame>();
  for (const r of findRipples(before, after, changes)) for (const id of r.moved) out.set(id, r.shift);
  return out;
}

// ---------- wording ----------

export function label(c: Clip): string {
  return String(c.props.name ?? c.props.text ?? c.id);
}

/** 300 frames at 30 fps → "10s"; 45 → "1.5s". */
export function fmtTime(frames: Frame, fps: number): string {
  return `${Math.round((frames / fps) * 100) / 100}s`;
}

/** Signed, with a real minus sign: "+1s", "−10s". */
export function fmtShift(frames: Frame, fps: number): string {
  return (frames < 0 ? '−' : '+') + fmtTime(Math.abs(frames), fps);
}

const fmtValue = (v: unknown) => (v === undefined ? 'none' : String(v));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const q = (c: Clip) => `"${label(c)}"`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function intents(before: Timeline, after: Timeline, changes = diff(before, after)): Intent[] {
  const fps = after.fps;
  const out: Intent[] = [];
  const used = new Set<string>(); // added/removed ids already explained
  const absorbed = new Map<string, Set<Group>>(); // modified id → groups already explained
  const absorb = (id: string, ...gs: Group[]) => {
    const set = absorbed.get(id) ?? new Set<Group>();
    for (const g of gs) set.add(g);
    absorbed.set(id, set);
  };
  const byId = new Map(changes.map((c) => [c.id, c]));
  const clipOf = (id: string): Clip => {
    const c = byId.get(id)!;
    return c.kind === 'removed' ? c.before : c.after;
  };

  // 1. Ripples: one sentence for the edit and everything it pushed.
  for (const r of findRipples(before, after, changes)) {
    for (const id of r.moved) absorb(id, 'placement');
    for (const id of r.alsoRemoved) used.add(id);
    for (const id of r.alsoTrimmed) absorb(id, 'trim', 'placement');
    const moved = `${plural(r.moved.length, 'clip')} moved ${fmtShift(r.shift, fps)}`;
    const withList = r.alsoRemoved.length ? ` (with ${r.alsoRemoved.map((id) => q(clipOf(id))).join(', ')})` : '';
    let text: string;
    let at: Frame;
    if (r.cause?.kind === 'delete') {
      used.add(r.cause.id);
      const c = clipOf(r.cause.id);
      text = `Ripple delete ${q(c)}${withList}: ${moved}`;
      at = c.start;
    } else if (r.cause?.kind === 'trim') {
      absorb(r.cause.id, 'trim');
      const c = clipOf(r.cause.id);
      text = `Ripple trim ${q(c)} (end ${fmtShift(r.shift, fps)})${withList}: ${moved}`;
      at = end(c);
    } else if (r.cause?.kind === 'insert') {
      used.add(r.cause.id);
      const c = clipOf(r.cause.id);
      text = `Ripple insert ${q(c)}: ${moved}`;
      at = c.start;
    } else {
      text = `${cap(moved.replace(' moved', ' moved together'))}`;
      at = r.moved.reduce((min, id) => Math.min(min, clipOf(id).start), Infinity);
    }
    const clips = [...(r.cause ? [r.cause.id] : []), ...r.alsoRemoved, ...r.alsoTrimmed, ...r.moved];
    out.push({ kind: 'ripple', text, clips, at });
  }

  // 2. Splits: a clip got shorter and a new clip continues exactly where it now ends.
  for (const a of changes.filter(isAdd)) {
    if (used.has(a.id)) continue;
    const left = changes.find((m): m is Modified =>
      isMod(m) && m.groups.includes('trim') && !absorbed.get(m.id)?.has('trim') &&
      m.after.track === a.after.track && m.after.source === a.after.source &&
      m.after.in === m.before.in && m.after.out < m.before.out &&
      a.after.in === m.after.out && a.after.start === end(m.after));
    if (!left) continue;
    used.add(a.id);
    absorb(left.id, 'trim');
    out.push({ kind: 'split', text: `Split ${q(left.after)} at ${fmtTime(a.after.start, fps)}`, clips: [left.id, a.id], at: a.after.start });
  }

  // 3. Everything else, in plain words.
  for (const c of changes) {
    if (c.kind === 'added') {
      if (!used.has(c.id)) out.push({ kind: 'added', text: `Added ${q(c.after)}`, clips: [c.id], at: c.after.start });
      continue;
    }
    if (c.kind === 'removed') {
      if (!used.has(c.id)) out.push({ kind: 'removed', text: `Removed ${q(c.before)}`, clips: [c.id], at: c.before.start });
      continue;
    }
    const left = c.groups.filter((g) => !absorbed.get(c.id)?.has(g));
    out.push(...describe(c, left, before, after));
  }

  return out.sort((x, y) => x.at - y.at || (x.text < y.text ? -1 : 1));
}

function describe(m: Modified, groups: Group[], before: Timeline, after: Timeline): Intent[] {
  const { before: b, after: a, id } = m;
  const fps = after.fps;
  const res: Intent[] = [];
  const say = (kind: IntentKind, text: string) => res.push({ kind, text, clips: [id], at: a.start });

  // A start-trim changes placement too; the placement part is not a separate move.
  const startTrim = groups.includes('trim') && a.track === b.track && a.start - b.start === a.in - b.in;
  if (groups.includes('placement') && !startTrim) {
    if (a.track !== b.track) {
      const name = after.tracks.find((t) => t.id === a.track)?.name ?? a.track;
      say('moved', `Moved ${q(a)} to ${name} at ${fmtTime(a.start, fps)}`);
    } else {
      say('moved', `Moved ${q(a)} ${fmtShift(a.start - b.start, fps)}`);
    }
  }
  if (groups.includes('trim')) {
    const parts: string[] = [];
    if (a.in !== b.in) parts.push(`start ${fmtShift(a.in - b.in, fps)}`);
    if (a.out !== b.out) parts.push(`end ${fmtShift(a.out - b.out, fps)}`);
    say('trimmed', `Trimmed ${q(a)} (${parts.join(', ')})`);
  }
  if (groups.includes('source')) say('source', `Changed media of ${q(a)}: ${b.source} → ${a.source}`);
  if (groups.includes('effects')) {
    const plus = a.effects.filter((e) => !b.effects.includes(e));
    const minus = b.effects.filter((e) => !a.effects.includes(e));
    const parts = [
      ...(plus.length ? [`added ${plus.join(', ')}`] : []),
      ...(minus.length ? [`removed ${minus.join(', ')}`] : []),
    ];
    say('effects', `Effects on ${q(a)}: ${parts.length ? parts.join('; ') : 'reordered'}`);
  }
  for (const g of groups) {
    if (!g.startsWith('prop:')) continue;
    const key = g.slice(5);
    const from = b.props[key];
    const to = a.props[key];
    if (key === 'text') say('prop', `Changed text: "${fmtValue(from)}" → "${fmtValue(to)}"`);
    else if (key === 'name') say('prop', `Renamed "${fmtValue(from)}" → "${fmtValue(to)}"`);
    else say('prop', `${cap(key)} of ${q(a)}: ${fmtValue(from)} → ${fmtValue(to)}`);
  }
  return res;
}

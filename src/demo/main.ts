// The demo page. It uses the real core and a real in-memory repo:
// every button press is a real commit, and the merge preview is the real merge.

import { runBench, type BenchRow } from '../bench/run.ts';
import { canonical } from '../core/canonical.ts';
import { diff, type Group } from '../core/diff.ts';
import { fmtTime, type Intent, label } from '../core/intents.ts';
import { type Conflict, merge, type MergeResult, type Origin } from '../core/merge.ts';
import { addClip, deleteClip, moveClip, rippleDelete, rippleTrimEnd, setProp, split, toggleEffect } from '../core/ops.ts';
import { Repo, type CommitInfo } from '../core/repo.ts';
import { sampleTimeline } from '../core/sample.ts';
import { aditiSteps, rahulSteps } from '../core/scenario.ts';
import { MemoryObjectStore, MemoryRefStore } from '../core/store.ts';
import { type Clip, type Timeline, end } from '../core/timeline.ts';

type Who = 'aditi' | 'rahul';
const PEOPLE: Record<Who, string> = { aditi: 'Aditi', rahul: 'Rahul' };
const NAMES = { ours: 'Aditi', theirs: 'Rahul' };
const sideOf = (o: 'ours' | 'theirs'): Who => (o === 'ours' ? 'aditi' : 'rahul');

// ---------- state ----------

let repo: Repo;
let store: MemoryObjectStore;
let choices: Record<string, string> = {};
/** Conflict ids that existed right before the last choice, to mark ones that appeared because of it. */
let beforeChoice: Set<string> | null = null;
const selected: Record<Who, string | null> = { aditi: null, rahul: null };
const errors: Record<Who, string> = { aditi: '', rahul: '' };
let savedMsg = '';
let bench: BenchRow | 'running' | null = null;

async function startOver() {
  store = new MemoryObjectStore();
  repo = new Repo(store, new MemoryRefStore());
  await repo.init(sampleTimeline(), 'Start: rough cut', 'Producer');
  await repo.createBranch('aditi');
  await repo.createBranch('rahul');
  choices = {};
  beforeChoice = null;
  selected.aditi = selected.rahul = null;
  errors.aditi = errors.rahul = '';
  savedMsg = '';
}

async function loadExample() {
  await startOver();
  for (const [who, steps] of [['aditi', aditiSteps], ['rahul', rahulSteps]] as const) {
    let head = (await repo.branches())[who];
    for (const step of steps) {
      head = await repo.commit(who, step.apply(await repo.checkout(who)), { expectedHead: head, message: step.label, author: PEOPLE[who] });
    }
  }
}

// ---------- tiny DOM helper ----------

type Child = Node | string | null | undefined | false;
function h(tag: string, attrs: Record<string, unknown> = {}, ...children: (Child | Child[])[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const secs = (tl: Timeline, f: number) => fmtTime(f, tl.fps);
const clipText = (c: Clip) => (c.source === 'text' && c.props.text ? `“${c.props.text}”` : label(c));
const q = (c: Clip) => `“${label(c)}”`;

// ---------- lanes ----------

interface LaneItem {
  clip: Clip;
  ghost?: boolean;
  pending?: boolean;
  outline?: Who;
  bar?: Origin;
  conflict?: boolean;
}

function lane(tl: Timeline, items: LaneItem[], o: { name: string; who?: Who; key: string }): HTMLElement {
  const total = Math.max(40 * tl.fps, ...items.map((i) => end(i.clip)));
  const length = Math.ceil(total / (5 * tl.fps)) * 5 * tl.fps;
  const pct = (f: number) => `${(f / length) * 100}%`;
  const rowOf = new Map(tl.tracks.map((t, i) => [t.id, i]));

  const ticks: HTMLElement[] = [];
  for (let f = 0; f < length; f += 5 * tl.fps) {
    const s = f / tl.fps;
    ticks.push(h('span', { class: 'tick', style: `left:${pct(f)}` }, `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`));
  }

  const rows = tl.tracks.map((t) => {
    const clips = items.filter((i) => i.clip.track === t.id).map((i) => {
      const c = i.clip;
      const cls = [
        'clip', `r${rowOf.get(t.id)! % 4}`,
        i.ghost && 'ghost', i.pending && 'pending', i.conflict && 'conflict',
        i.outline && `new-${i.outline}`, c.effects.includes('grain') && !i.ghost && 'fx',
      ].filter(Boolean).join(' ');
      const style = `left:${pct(c.start)};width:${pct(end(c) - c.start)}`;
      const title = `${clipText(c)} · ${secs(tl, c.start)}–${secs(tl, end(c))}`;
      const kids = [i.bar ? h('span', { class: `bar ${i.bar === 'ours' ? 'aditi' : i.bar === 'theirs' ? 'rahul' : 'both'}` }) : null, h('span', { class: 'name' }, clipText(c))];
      if (o.who && !i.ghost) {
        const who = o.who;
        return h('button', {
          class: cls, style, title, 'data-clip': c.id, 'data-key': `${o.key}:${c.id}`,
          'aria-pressed': String(selected[who] === c.id),
          'aria-label': `${clipText(c)}, ${t.name}, ${secs(tl, c.start)} to ${secs(tl, end(c))}`,
          onclick: () => { selected[who] = selected[who] === c.id ? null : c.id; errors[who] = ''; render(); },
        }, kids);
      }
      return h('div', { class: cls, style, title, 'data-clip': c.id, 'aria-hidden': i.ghost ? 'true' : undefined }, kids);
    });
    return h('div', { class: 'row' }, h('div', { class: 'label' }, t.name), h('div', { class: 'area' }, clips));
  });

  return h('div', { class: 'lane-scroll' },
    h('div', { class: 'lane', role: 'group', 'aria-label': o.name, 'data-lane': o.key },
      h('div', { class: 'row' }, h('div', { class: 'label' }), h('div', { class: 'area ruler', 'aria-hidden': 'true' }, ticks)),
      rows));
}

/** Hovering or focusing a sentence lights up its clips in one lane. */
function highlighter(laneKey: string, clips: string[]) {
  const on = () => {
    const l = document.querySelector(`[data-lane="${laneKey}"]`);
    if (!l) return;
    l.classList.add('hovering');
    for (const el of l.querySelectorAll<HTMLElement>('[data-clip]')) el.classList.toggle('hl', clips.includes(el.dataset.clip!));
  };
  const off = () => {
    const l = document.querySelector(`[data-lane="${laneKey}"]`);
    l?.classList.remove('hovering');
    for (const el of l?.querySelectorAll('.hl') ?? []) el.classList.remove('hl');
  };
  return { onmouseenter: on, onmouseleave: off, onfocus: on, onblur: off };
}

// ---------- editing ----------

async function edit(who: Who, message: string, fn: (tl: Timeline) => Timeline) {
  try {
    const head = (await repo.branches())[who];
    const next = fn(await repo.checkout(who));
    await repo.commit(who, next, { expectedHead: head, message, author: PEOPLE[who] });
    errors[who] = '';
    if (selected[who] && !next.clips[selected[who]!]) selected[who] = null;
    beforeChoice = null;
    savedMsg = '';
  } catch (e) {
    errors[who] = (e as Error).message;
  }
  render();
}

function toolbar(who: Who, tl: Timeline): HTMLElement | null {
  const id = selected[who];
  const c = id ? tl.clips[id] : null;
  if (!c) return null;
  const fps = tl.fps;
  const k = (s: string) => `${who}:tool:${s}`;
  const op = c.props.opacity;
  const nextOp = op === undefined ? 0.8 : op === 0.8 ? 0.5 : null;
  const btn = (key: string, text: string, message: string, fn: (t: Timeline) => Timeline, extra: Record<string, unknown> = {}) =>
    h('button', { class: 'btn sm', 'data-key': k(key), onclick: () => edit(who, message, fn), ...extra }, text);
  const grade = c.props.grade;
  const nextGrade = grade === undefined ? 'warm' : grade === 'warm' ? 'cool' : null;
  const isText = c.source === 'text';
  const input = h('input', {
    type: 'text', value: isText ? String(c.props.text ?? '') : '', placeholder: 'Title text',
    'aria-label': isText ? 'Text of this title' : 'Text for a new title', 'data-key': k('text-input'),
  }) as HTMLInputElement;
  const half = c.start + Math.floor((end(c) - c.start) / 2);

  return h('div', { class: 'toolbar' },
    h('div', { class: 'title' }, h('strong', {}, clipText(c)), ' ', h('span', { class: 'mono' }, `${secs(tl, c.start)}–${secs(tl, end(c))}`)),
    h('div', { class: 'tools' },
      btn('left', '−1s', `Move ${q(c)} −1s`, (t) => moveClip(t, c.id, Math.max(0, c.start - fps)), { 'aria-label': 'Move one second earlier' }),
      btn('right', '+1s', `Move ${q(c)} +1s`, (t) => moveClip(t, c.id, c.start + fps), { 'aria-label': 'Move one second later' }),
      btn('rtrim', 'Ripple trim 1s', `Ripple trim ${q(c)} by 1s`, (t) => rippleTrimEnd(t, c.id, fps)),
      btn('rdel', 'Ripple delete', `Ripple delete ${q(c)}`, (t) => rippleDelete(t, c.id)),
      btn('del', 'Delete', `Delete ${q(c)}`, (t) => deleteClip(t, c.id)),
      btn('split', 'Split at middle', `Split ${q(c)} at ${secs(tl, half)}`, (t) => split(t, c.id, half), { disabled: half <= c.start }),
    ),
    h('div', { class: 'tools' },
      btn('grain', 'Grain', `Grain on ${q(c)}`, (t) => toggleEffect(t, c.id, 'grain'), { 'aria-pressed': String(c.effects.includes('grain')) }),
      btn('opacity', `Opacity: ${op ?? 'none'} → ${nextOp ?? 'none'}`, `Opacity of ${q(c)} → ${nextOp ?? 'none'}`, (t) => setProp(t, c.id, 'opacity', nextOp)),
      btn('grade', `Grade: ${grade ?? 'none'} → ${nextGrade ?? 'none'}`, `Grade of ${q(c)} → ${nextGrade ?? 'none'}`, (t) => setProp(t, c.id, 'grade', nextGrade)),
    ),
    h('div', { class: 'tools' },
      input,
      isText && h('button', {
        class: 'btn sm', 'data-key': k('text'),
        onclick: () => edit(who, `Text of ${q(c)} → “${input.value}”`, (t) => setProp(t, c.id, 'text', input.value)),
      }, 'Set text'),
      c.track !== 'T1' && h('button', {
        class: 'btn sm', 'data-key': k('add-title'),
        onclick: () => {
          const text = input.value.trim() || 'New title';
          edit(who, `Add “${text}”`, (t) => addOver(t, who, c, 'T1', 3 * fps, 'title', 'text', text));
        },
      }, 'Add title here'),
      c.track !== 'V2' && !isText &&
        btn('add-broll', 'Add b-roll here', `Add b-roll over ${q(c)}`, (t) => addOver(t, who, c, 'V2', 2 * fps, 'broll', 'broll.mp4', 'New b-roll')),
    ));
}

/**
 * Adds a new clip on `track`, over the selected clip: at its start if that
 * spot is free, otherwise at the first free whole second while still over it.
 * Ids start with the editor's name, so two branches never invent the same id
 * for two different clips (the merge would think they are one clip).
 */
function addOver(t: Timeline, who: Who, over: Clip, track: string, len: number, kind: string, source: string, name: string): Timeline {
  let n = 1;
  while (t.clips[`${who}-${kind}-${n}`]) n++;
  const id = `${who}-${kind}-${n}`;
  const props: Record<string, string> = source === 'text' ? { name, text: name } : { name };
  for (let start = over.start; start < end(over); start += t.fps) {
    try {
      return addClip(t, { id, track, start, source, in: 0, out: len, props, effects: [] });
    } catch { /* that spot is taken; try one second later */ }
  }
  const trackName = t.tracks.find((x) => x.id === track)?.name ?? track;
  throw new Error(`No free ${len / t.fps}s on ${trackName} over ${q(over)}. Move or delete a clip there first.`);
}

// ---------- conflict wording ----------

function groupName(g: Group): string {
  if (g === 'placement') return 'position';
  if (g === 'trim') return 'trim';
  if (g === 'source') return 'media file';
  if (g === 'effects') return 'effects';
  return g.slice(5);
}

function groupValue(tl: Timeline, c: Clip, g: Group): string {
  if (g === 'placement') return `at ${secs(tl, c.start)} on ${tl.tracks.find((t) => t.id === c.track)?.name ?? c.track}`;
  if (g === 'trim') return `${secs(tl, c.out - c.in)} long`;
  if (g === 'source') return c.source;
  if (g === 'effects') return c.effects.length ? c.effects.join(', ') : 'no effects';
  const v = c.props[g.slice(5)];
  return v === undefined ? 'none' : g === 'prop:text' ? `“${v}”` : String(v);
}

interface Card { title: string; why: string; options: [string, string][] }

function describe(c: Conflict, tls: { base: Timeline; ours: Timeline; theirs: Timeline; merged: Timeline }): Card {
  const any = (id: string) => tls.merged.clips[id] ?? tls.ours.clips[id] ?? tls.theirs.clips[id] ?? tls.base.clips[id];
  if (c.kind === 'edit-edit') {
    const o = tls.ours.clips[c.clip];
    const t = tls.theirs.clips[c.clip];
    const what = c.group === 'prop:text' ? 'text' : groupName(c.group);
    return {
      title: `${q(any(c.clip))}: two different ${what}s`,
      why: `Aditi made it ${groupValue(tls.ours, o, c.group)}. Rahul made it ${groupValue(tls.theirs, t, c.group)}. Only one can win.`,
      options: [
        ['ours', `Keep Aditi’s: ${groupValue(tls.ours, o, c.group)}`],
        ['theirs', `Keep Rahul’s: ${groupValue(tls.theirs, t, c.group)}`],
      ],
    };
  }
  if (c.kind === 'delete-edit') {
    const deleter = PEOPLE[sideOf(c.deletedBy)];
    const keeper = PEOPLE[sideOf(c.deletedBy === 'ours' ? 'theirs' : 'ours')];
    return {
      title: `${q(any(c.clip))}: deleted and edited`,
      why: `${deleter} removed this clip. ${keeper} changed its ${c.edits.map(groupName).join(' and ')}. Keeping it may need room on the track.`,
      options: [['delete', 'Delete it'], ['keep', `Keep ${keeper}’s edited version`]],
    };
  }
  const [a, b] = c.clips.map(any);
  const track = tls.merged.tracks.find((t) => t.id === c.track)?.name ?? c.track;
  return {
    title: `${clipText(a)} and ${clipText(b)} overlap`,
    why: `Each branch placed a clip here, and after the merge they cover the same ${secs(tls.merged, c.amount)} on ${track}. Neither editor saw this overlap.`,
    options: [
      ['make-room', `Make room: push ${clipText(b)} later`],
      [`drop:${a.id}`, `Drop ${clipText(a)}`],
      [`drop:${b.id}`, `Drop ${clipText(b)}`],
    ],
  };
}

function choose(id: string, choice: string | null, current: Conflict[]) {
  beforeChoice = new Set(current.map((c) => c.id));
  if (choice === null) delete choices[id];
  else choices[id] = choice;
  savedMsg = '';
  render();
}

// ---------- sections ----------

function section(num: string, title: string, intro: string | null, ...body: (Child | Child[])[]) {
  return h('section', { 'aria-labelledby': `h-${num}` },
    h('div', { class: 'sec-head' }, h('span', { class: 'sec-num', 'aria-hidden': 'true' }, num), h('h2', { id: `h-${num}` }, title)),
    intro && h('p', { class: 'sec-intro' }, intro),
    ...body);
}

function intentList(items: Intent[], laneKey: string): HTMLElement {
  if (!items.length) return h('p', { class: 'empty' }, 'No changes yet. Click a clip to edit it.');
  return h('ul', { class: 'intents' }, items.map((i, n) =>
    h('li', { tabindex: 0, 'data-key': `${laneKey}:intent:${n}`, ...highlighter(laneKey, i.clips) },
      h('span', { class: 'kind' }, i.kind), h('span', {}, i.text))));
}

function branchPanel(who: Who, tl: Timeline, fork: Timeline, intents: Intent[]): HTMLElement {
  const items: LaneItem[] = [];
  // Ghosts: where clips used to be before this branch moved or removed them.
  for (const ch of diff(fork, tl)) {
    if (ch.kind === 'removed') items.push({ clip: ch.before, ghost: true });
    if (ch.kind === 'modified' && ch.groups.includes('placement')) items.push({ clip: ch.before, ghost: true });
  }
  for (const c of Object.values(tl.clips)) items.push({ clip: c, outline: fork.clips[c.id] ? undefined : who });
  return h('div', { class: `panel ${who}` },
    h('div', { class: 'panel-head' }, h('span', { class: 'who' }, `${PEOPLE[who]}’s branch`), h('span', { class: 'hint' }, 'Click a clip to edit')),
    lane(tl, items, { name: `${PEOPLE[who]}’s timeline`, who, key: who }),
    toolbar(who, tl),
    h('p', { class: 'status', role: 'status' }, errors[who]),
    h('h3', {}, `What ${PEOPLE[who]} changed`),
    intentList(intents, who));
}

function mergeSection(r: MergeResult, tls: { base: Timeline; ours: Timeline; theirs: Timeline }): HTMLElement {
  const merged = r.timeline;
  const all = { ...tls, merged };
  const conflictClips = new Set<string>();
  const pending: Clip[] = [];
  for (const c of r.conflicts) {
    if (c.kind === 'edit-edit') conflictClips.add(c.clip);
    if (c.kind === 'overlap') c.clips.forEach((id) => conflictClips.add(id));
    if (c.kind === 'delete-edit') pending.push((c.deletedBy === 'ours' ? tls.theirs : tls.ours).clips[c.clip]);
  }
  const items: LaneItem[] = [
    ...pending.map((clip) => ({ clip, pending: true, conflict: true })),
    ...Object.values(merged.clips).map((clip) => ({ clip, bar: r.origin[clip.id], conflict: conflictClips.has(clip.id) })),
  ];

  const cards = r.conflicts.map((c) => {
    const d = describe(c, all);
    const isNew = beforeChoice !== null && !beforeChoice.has(c.id);
    return h('article', { class: 'card', 'data-conflict': c.id, ...highlighter('merge', c.kind === 'overlap' ? c.clips : [c.clip]) },
      isNew && h('span', { class: 'badge' }, 'appeared after your last choice'),
      h('h4', {}, d.title),
      h('p', {}, d.why),
      h('div', { class: 'options' }, d.options.map(([value, text]) =>
        h('button', { class: 'btn sm', 'data-key': `choice:${c.id}:${value}`, onclick: () => choose(c.id, value, r.conflicts) }, text))));
  });

  const decisions = r.resolved.map(({ conflict, choice }) => {
    const d = describe(conflict, all);
    const picked = d.options.find(([v]) => v === choice)?.[1] ?? choice;
    return h('li', {}, `${d.title} → ${picked} `,
      h('button', { class: 'linkish', 'data-key': `change:${conflict.id}`, onclick: () => choose(conflict.id, null, r.conflicts) }, 'Change'));
  });

  const canSave = r.conflicts.length === 0;
  const left = h('div', {},
    lane(merged, items, { name: 'Merge preview', key: 'merge' }),
    h('ul', { class: 'legend' },
      h('li', {}, h('span', { class: 'sw', style: 'background:var(--aditi)' }), 'Aditi changed it'),
      h('li', {}, h('span', { class: 'sw', style: 'background:var(--rahul)' }), 'Rahul changed it'),
      h('li', {}, h('span', { class: 'sw', style: 'background:linear-gradient(90deg,var(--aditi) 50%,var(--rahul) 50%)' }), 'Both'),
      h('li', {}, h('span', { class: 'sw', style: 'background:repeating-linear-gradient(135deg,var(--conflict) 0 2px,transparent 2px 5px);border:1px solid var(--conflict)' }), 'Needs a decision')),
    h('div', { class: 'save-row' },
      h('button', {
        class: 'btn primary', id: 'save', 'data-key': 'save', disabled: !canSave,
        onclick: saveMerge,
      }, 'Save merge to main'),
      savedMsg ? h('p', { class: 'done', role: 'status' }, savedMsg)
        : h('span', { class: 'hint' }, canSave ? 'No open questions.' : `${r.conflicts.length} ${r.conflicts.length === 1 ? 'question' : 'questions'} left`)));

  const questions = h('div', {},
    h('p', { class: 'kicker' }, `Needs a decision (${r.conflicts.length})`),
    cards.length ? h('div', { class: 'cards' }, cards) : h('p', { class: 'allclear' }, 'Nothing to decide.'));
  const automatic = h('div', {},
    h('p', { class: 'kicker' }, 'Merged by itself'),
    r.notes.length
      ? h('ul', { class: 'plain notes' }, r.notes.map((n, i) => h('li', { tabindex: 0, 'data-key': `note:${i}`, ...highlighter('merge', n.clips) }, n.text)))
      : h('p', { class: 'empty' }, 'Every change came from one side only, so each was taken as it is.'),
    decisions.length > 0 && [h('p', { class: 'kicker' }, 'Your decisions'), h('ul', { class: 'plain' }, decisions)]);

  // The lane gets the full width; the questions and the automatic notes sit side by side below it.
  return section('03', 'Merge preview',
    'Recomputed after every edit and every choice. The top bar on each clip shows who changed it.',
    left,
    h('div', { class: 'merge-grid' }, questions, automatic));
}

async function saveMerge() {
  const heads = await repo.branches();
  await repo.merge('main', 'aditi', { message: 'Take Aditi’s branch', author: 'You' });
  const out = await repo.merge('main', 'rahul', { choices, names: NAMES, message: 'Merge Aditi and Rahul', author: 'You' });
  if (out.status === 'conflicts') return render();
  const head = (await repo.branches()).main;
  // Both editors continue from the merged cut.
  await repo.resetBranch('aditi', head, heads.aditi);
  await repo.resetBranch('rahul', head, heads.rahul);
  choices = {};
  beforeChoice = null;
  selected.aditi = selected.rahul = null;
  savedMsg = `Saved to main as ${head.slice(0, 7)}. Both branches now start from the merged cut.`;
  await render();
  document.querySelector<HTMLElement>('#h-04')?.scrollIntoView({ block: 'start' });
}

function logList(commits: CommitInfo[]): HTMLElement {
  return h('ol', { class: 'log' }, commits.map((c) =>
    h('li', {},
      h('span', { class: 'hash' }, c.hash.slice(0, 7)),
      h('span', {}, c.message, c.parents.length > 1 && h('span', { class: 'merge' }, 'merge'), h('span', { class: 'hint' }, ` · ${c.author}`)))));
}

async function historySection(): Promise<HTMLElement> {
  const logs = { main: await repo.log('main', 12), aditi: await repo.log('aditi', 12), rahul: await repo.log('rahul', 12) };
  const unique = new Set([...logs.main, ...logs.aditi, ...logs.rahul].map((c) => c.hash));
  const stats = await repo.stats();
  const full = canonical(await repo.checkout('main')).length * unique.size;
  const kb = (b: number) => `${(b / 1024).toFixed(1)} KB`;
  return section('04', 'History',
    'Every edit above is a real commit. Content-addressed storage keeps only what changed.',
    h('div', { class: 'history' },
      ...(['main', 'aditi', 'rahul'] as const).map((b) => h('div', {}, h('h3', {}, b === 'main' ? 'main' : `${PEOPLE[b]}’s branch`), logList(logs[b])))),
    h('dl', { class: 'stats' },
      h('div', {}, h('dt', {}, 'Commits'), h('dd', {}, String(unique.size))),
      h('div', {}, h('dt', {}, 'Objects stored'), h('dd', {}, String(stats.objects))),
      h('div', {}, h('dt', {}, 'Stored'), h('dd', {}, kb(stats.bytes))),
      h('div', {}, h('dt', {}, 'As full copies'), h('dd', {}, kb(full)))),
    // Honest about scale: each commit writes a tree of 64 bucket hashes (about 4 KB),
    // which is more than this whole 11-clip project. Buckets pay off on real projects.
    h('p', { class: 'hint', style: 'max-width:64ch' },
      stats.bytes > full
        ? 'On an 11-clip project the fixed cost of each commit (a tree of 64 bucket hashes) is larger than a full copy. That cost stays the same as projects grow, while a copy grows with every clip: at 1,000 clips, storage is 16× smaller than full copies. Run the benchmark below to see it.'
        : 'Only changed clips and their buckets are written; everything else is shared by hash.'));
}

function howSection(): HTMLElement {
  const para = (title: string, text: string) => h('div', {}, h('h3', {}, title), h('p', {}, text));
  const ms = (x: number) => `${x.toFixed(1)} ms`;
  return section('05', 'How the merge decides', null,
    h('div', { class: 'how' },
      para('Clips have names, not positions',
        'Every clip keeps one id for its whole life. So the merge can say "Point 3 moved and got grain" instead of "everything after 14 seconds changed". Changes are compared in groups that match one editing intent: position, trim, media, effects, and each property.'),
      para('Ripples add up',
        'When Aditi cuts 10 seconds and Rahul trims 1 second earlier in the film, both pull Point 3 left. Those are not two opinions about where Point 3 goes; both are true at once. So the shifts add up: −10 s and −1 s makes −11 s.'),
      para('New clips keep their context',
        'Git keeps the lines around a change. A new clip keeps the clip it was placed against: its closest neighbour, or the clip it sits on top of. When that clip moves in the merge, the new clip moves with it.'),
      para('Time is checked last',
        'Text has no rule like "two things cannot be in the same place". Video does. After merging, any two clips that overlap on a track, and did not overlap on either branch, become a question. Every choice runs the check again.')),
    h('div', { class: 'bench' },
      h('button', {
        class: 'btn', 'data-key': 'bench', disabled: bench === 'running',
        onclick: async () => {
          bench = 'running';
          await render();
          await new Promise((r) => setTimeout(r, 40)); // let the page paint "Running…"
          bench = await runBench(5000, { commits: 30, runs: 5 });
          await render();
        },
      }, bench === 'running' ? 'Running…' : 'Run the 5,000-clip benchmark here'),
      bench && bench !== 'running' && h('table', {},
        h('thead', {}, h('tr', {}, ['Clips', 'Commit', 'Diff', 'Merge', 'Storage vs full copies'].map((t) => h('th', {}, t)))),
        h('tbody', {}, h('tr', {},
          h('td', {}, bench.clips.toLocaleString('en')), h('td', {}, ms(bench.commitMs)),
          h('td', {}, ms(bench.diffMs)), h('td', {}, ms(bench.mergeMs)), h('td', {}, `${bench.ratio.toFixed(1)}× smaller`)))),
      h('p', { class: 'hint' }, 'Medians on your machine, with the same code as the tests.')));
}

// ---------- render ----------

let renderSeq = 0;

async function render(): Promise<void> {
  const seq = ++renderSeq;
  const heads = await repo.branches();
  const main = await repo.checkout('main');
  const tl = { aditi: await repo.checkout('aditi'), rahul: await repo.checkout('rahul') };
  const fork = {
    aditi: await repo.checkout((await repo.mergeBase(heads.main, heads.aditi))!),
    rahul: await repo.checkout((await repo.mergeBase(heads.main, heads.rahul))!),
  };
  const intents = {
    aditi: (await repo.diff(heads.main, 'aditi')).intents,
    rahul: (await repo.diff(heads.main, 'rahul')).intents,
  };
  const base = await repo.checkout((await repo.mergeBase(heads.aditi, heads.rahul))!);
  let result: MergeResult;
  try {
    result = merge(base, tl.aditi, tl.rahul, { choices, names: NAMES });
  } catch {
    // A saved choice no longer fits (the conflict changed after an edit): forget the choices.
    choices = {};
    result = merge(base, tl.aditi, tl.rahul, { names: NAMES });
  }
  const history = await historySection();
  if (seq !== renderSeq) return; // a newer render started while we waited

  const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.key;
  const app = document.getElementById('app')!;
  app.replaceChildren(
    section('01', 'Starting point', 'The rough cut on main. Both editors branch from here.',
      lane(main, Object.values(main.clips).map((clip) => ({ clip })), { name: 'Main timeline', key: 'main' })),
    section('02', 'Two branches, edited at the same time',
      'Dashed outlines show where clips were before. New clips are outlined in the editor’s colour. Hover a sentence to see its clips.',
      h('div', { class: 'branches' }, branchPanel('aditi', tl.aditi, fork.aditi, intents.aditi), branchPanel('rahul', tl.rahul, fork.rahul, intents.rahul))),
    mergeSection(result, { base, ours: tl.aditi, theirs: tl.rahul }),
    history,
    howSection(),
  );
  if (focusKey) document.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
}

// ---------- theme ----------

const THEMES = ['auto', 'light', 'dark'] as const;
function applyTheme(t: (typeof THEMES)[number]) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const btn = document.getElementById('theme')!;
  btn.textContent = `Theme: ${t}`;
  btn.setAttribute('aria-label', `Colour theme: ${t === 'auto' ? 'automatic' : t}`);
}

function initTheme() {
  let t: (typeof THEMES)[number] = 'auto';
  try {
    const saved = localStorage.getItem('branchcut-theme');
    if (saved === 'light' || saved === 'dark') t = saved;
  } catch { /* storage can be blocked; the default is fine */ }
  applyTheme(t);
  document.getElementById('theme')!.addEventListener('click', () => {
    t = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
    applyTheme(t);
    try { localStorage.setItem('branchcut-theme', t); } catch { /* ignore */ }
  });
}

// ---------- start ----------

async function main() {
  initTheme();
  document.getElementById('load')!.addEventListener('click', async () => { await loadExample(); await render(); });
  document.getElementById('reset')!.addEventListener('click', async () => { await startOver(); await render(); });
  await loadExample();
  await render();
}

main();

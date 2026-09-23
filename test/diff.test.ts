import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleTimeline, FPS } from '../src/core/sample.ts';
import { addClip, deleteClip, moveClip, rippleDelete, setProp, split, toggleEffect, trimEnd } from '../src/core/ops.ts';
import { diff, changedGroups } from '../src/core/diff.ts';
import { intents, rippleShifts } from '../src/core/intents.ts';
import { aditiSteps, applySteps, rahulSteps } from '../src/core/scenario.ts';

const s = (sec: number) => sec * FPS;
const texts = (before = sampleTimeline(), after = before) => intents(before, after).map((i) => i.text);

// ---------- Level 1 ----------

test('level 1: no changes, no diff', () => {
  const tl = sampleTimeline();
  assert.deepEqual(diff(tl, tl), []);
});

test('level 1: added, removed and modified with field groups', () => {
  const base = sampleTimeline();
  const rahul = applySteps(base, rahulSteps);
  const d = diff(base, rahul);
  const byId = Object.fromEntries(d.map((c) => [c.id, c]));
  assert.equal(byId.whiteboard.kind, 'added');
  assert.equal(byId.built.kind, 'added');
  assert.deepEqual(byId.intro.kind === 'modified' && byId.intro.groups, ['trim', 'prop:grade']);
  assert.deepEqual(byId.p3.kind === 'modified' && byId.p3.groups, ['placement', 'effects']);
  assert.deepEqual(byId.laptop.kind === 'modified' && byId.laptop.groups, ['placement', 'prop:opacity']);
  assert.deepEqual(byId.title.kind === 'modified' && byId.title.groups, ['prop:text']);
  assert.equal(byId.music, undefined); // no sync lock, untouched

  const aditi = applySteps(base, aditiSteps);
  const removed = diff(base, aditi).filter((c) => c.kind === 'removed').map((c) => c.id);
  assert.deepEqual(removed, ['laptop', 'p2']);
});

test('level 1: each property is its own group; order of effects matters', () => {
  const base = sampleTimeline();
  let a = toggleEffect(toggleEffect(base, 'p1', 'blur'), 'p1', 'grain');
  let b = toggleEffect(toggleEffect(base, 'p1', 'grain'), 'p1', 'blur');
  assert.deepEqual(changedGroups(a.clips.p1, b.clips.p1), ['effects']);
  a = setProp(base, 'p1', 'opacity', 0.5);
  b = setProp(a, 'p1', 'grade', 'cool');
  assert.deepEqual(changedGroups(base.clips.p1, b.clips.p1), ['prop:grade', 'prop:opacity']);
});

// ---------- Level 2 ----------

test('a ripple delete of p2 gives exactly one intent, not five', () => {
  const base = sampleTimeline();
  const after = rippleDelete(base, 'p2');
  assert.equal(diff(base, after).length, 6); // p2, laptop, p3, outro, team, caption
  assert.deepEqual(texts(base, after), [
    'Ripple delete "Point 2" (with "Laptop b-roll"): 4 clips moved −10s',
  ]);
  const [one] = intents(base, after);
  assert.deepEqual([...one.clips].sort(), ['caption', 'laptop', 'outro', 'p2', 'p3', 'team']);
});

test("Aditi's branch in editor words", () => {
  const base = sampleTimeline();
  assert.deepEqual(texts(base, applySteps(base, aditiSteps)), [
    'Changed text: "Launch week" → "Ship week"',
    'Added "Three things we learned"',
    'Ripple delete "Point 2" (with "Laptop b-roll"): 4 clips moved −10s',
  ]);
});

test("Rahul's branch: the ripple is one sentence, other changes on moved clips still show", () => {
  const base = sampleTimeline();
  assert.deepEqual(texts(base, applySteps(base, rahulSteps)), [
    'Changed text: "Launch week" → "Launch week 2026"',
    'Grade of "Intro": none → warm',
    'Ripple trim "Intro" (end −1s): 8 clips moved −1s',
    'Opacity of "Laptop b-roll": none → 0.8',
    'Effects on "Point 3": added grain',
    'Added "Whiteboard b-roll"',
    'Added "Built in the browser"',
  ]);
});

test('clips that cross the edges of a ripple delete belong to the same sentence', () => {
  let base = deleteClip(sampleTimeline(), 'laptop');
  base = addClip(base, { id: 'a', track: 'V2', start: s(12), source: 'a.mp4', in: 0, out: s(4), props: { name: 'A' }, effects: [] });
  base = addClip(base, { id: 'b', track: 'V2', start: s(22), source: 'b.mp4', in: 0, out: s(4), props: { name: 'B' }, effects: [] });
  const after = rippleDelete(base, 'p2');
  assert.deepEqual(texts(base, after), ['Ripple delete "Point 2": 4 clips moved −10s']);
  assert.ok(intents(base, after)[0].clips.includes('a'));
  assert.ok(intents(base, after)[0].clips.includes('b'));
});

test('the ripple is blamed on the clip right before the moved clips, not an earlier one of the same length', () => {
  // From the demo video: Rahul deleted Point 1 (plain delete, 10s) and then
  // ripple-deleted Point 3 (also 10s). Only Point 3 caused the slide.
  const base = sampleTimeline();
  const after = rippleDelete(deleteClip(base, 'p1'), 'p3');
  assert.deepEqual(texts(base, after), [
    'Removed "Point 1"',
    'Ripple delete "Point 3" (with "Team b-roll"): 2 clips moved −10s',
  ]);
});

test('split is one sentence', () => {
  const base = sampleTimeline();
  assert.deepEqual(texts(base, split(base, 'p1', s(8))), ['Split "Point 1" at 8s']);
});

test('plain moves, trims, effects and properties', () => {
  const base = sampleTimeline();
  assert.deepEqual(texts(base, moveClip(base, 'city', s(7))), ['Moved "City b-roll" +1s']);
  const gap = deleteClip(base, 'p1'); // V1 is full at 6s, so make room first
  assert.deepEqual(texts(gap, moveClip(gap, 'city', s(6), 'V1')), ['Moved "City b-roll" to Main at 6s']);
  assert.deepEqual(texts(base, trimEnd(base, 'outro', s(1))), ['Trimmed "Outro" (end −1s)']);
  assert.deepEqual(texts(base, setProp(base, 'laptop', 'opacity', 0.8)), ['Opacity of "Laptop b-roll": none → 0.8']);
  assert.deepEqual(texts(base, setProp(base, 'p1', 'name', 'Point one')), ['Renamed "Point 1" → "Point one"']);
  assert.deepEqual(texts(base, deleteClip(base, 'city')), ['Removed "City b-roll"']);
});

test('two clips moved by the same unexplained amount count as one ripple', () => {
  const base = sampleTimeline();
  const after = moveClip(moveClip(base, 'city', s(5)), 'laptop', s(15));
  assert.deepEqual(texts(base, after), ['2 clips moved together −1s']);
});

test('rippleShifts: only clips that slid because of a ripple', () => {
  const base = sampleTimeline();
  const rahul = applySteps(base, rahulSteps);
  const shifts = rippleShifts(base, rahul);
  assert.equal(shifts.get('p3'), -s(1));
  assert.equal(shifts.get('laptop'), -s(1));
  assert.equal(shifts.has('intro'), false); // intro was trimmed, not moved
  assert.equal(shifts.size, 8);
  // A single deliberate move is not a ripple.
  assert.equal(rippleShifts(base, moveClip(base, 'city', s(7))).size, 0);
});

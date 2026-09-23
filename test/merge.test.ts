import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleTimeline, FPS } from '../src/core/sample.ts';
import { moveClip, rippleDelete, rippleTrimEnd, setProp } from '../src/core/ops.ts';
import { merge, type MergeResult } from '../src/core/merge.ts';
import { aditiSteps, applySteps, rahulSteps } from '../src/core/scenario.ts';
import { checkTimeline, end } from '../src/core/timeline.ts';

const s = (sec: number) => sec * FPS;
const names = { ours: 'Aditi', theirs: 'Rahul' };

function demo(choices: Record<string, string> = {}): MergeResult {
  const base = sampleTimeline();
  return merge(base, applySteps(base, aditiSteps), applySteps(base, rahulSteps), { choices, names });
}

const ids = (r: MergeResult) => r.conflicts.map((c) => c.id).sort();

test('demo merge: exactly 3 conflicts, one of each kind', () => {
  const r = demo();
  assert.deepEqual(ids(r), ['delete:laptop', 'edit:title:prop:text', 'overlap:T1:built:chapter']);
  assert.deepEqual(r.conflicts.map((c) => c.kind).sort(), ['delete-edit', 'edit-edit', 'overlap']);
  const overlap = r.conflicts.find((c) => c.kind === 'overlap');
  assert.equal(overlap?.kind === 'overlap' && overlap.amount, s(1));
});

test('demo merge: ripples add up, other edits survive the move', () => {
  const { timeline: tl, origin } = demo();
  const c = tl.clips;
  assert.equal(c.p3.start, s(13)); // −10s (Aditi) and −1s (Rahul)
  assert.deepEqual(c.p3.effects, ['grain']); // Rahul's grain survives Aditi's move
  assert.equal(c.outro.start, s(23));
  assert.equal(c.team.start, s(16));
  assert.equal(c.caption.start, s(24));
  assert.equal(c.p1.start, s(3));
  assert.equal(c.intro.props.grade, 'warm');
  assert.equal(end(c.intro), s(3));
  assert.equal(c.p2, undefined); // Rahul only rippled it
  assert.equal(c.laptop, undefined); // stays deleted until someone chooses
  assert.equal(c.title.props.text, 'Ship week'); // ours, for now
  assert.equal(origin.p3, 'theirs');
  assert.equal(origin.chapter, 'ours');
});

test('demo merge: new clips move with their anchor', () => {
  const r = demo();
  const c = r.timeline.clips;
  assert.equal(c.chapter.start, s(13)); // −1s with Point 3
  assert.equal(c.whiteboard.start, s(14)); // −10s with Point 3
  assert.equal(c.built.start, s(15)); // −10s with Point 3
  const texts = r.notes.map((n) => n.text);
  assert.ok(texts.includes('Moved new clip "Three things we learned" −1s to stay with "Point 3"'));
  assert.ok(texts.includes('Moved new clip "Whiteboard b-roll" −10s to stay with "Point 3"'));
  assert.ok(texts.includes('Moved new clip "Built in the browser" −10s to stay with "Point 3"'));
  assert.ok(texts.includes('Removed "Point 2": Aditi deleted it, Rahul only moved it in a ripple'));
  assert.ok(texts.includes('Both ripples add up: 4 clips moved −11s'));
});

test('keeping the laptop makes 2 new overlaps on B-roll; make-room everywhere ends with 0 conflicts', () => {
  let r = demo({ 'delete:laptop': 'keep', 'edit:title:prop:text': 'theirs' });
  assert.deepEqual(ids(r), [
    'overlap:T1:built:chapter',
    'overlap:V2:laptop:team',
    'overlap:V2:laptop:whiteboard',
  ]);
  assert.equal(r.timeline.clips.laptop.props.opacity, 0.8);
  assert.equal(r.timeline.clips.title.props.text, 'Launch week 2026');

  const choices: Record<string, string> = { 'delete:laptop': 'keep', 'edit:title:prop:text': 'theirs' };
  for (const c of r.conflicts) choices[c.id] = 'make-room';
  r = demo(choices);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.resolved.length, 5);
  checkTimeline(r.timeline); // no overlaps left, all valid
  assert.equal(r.timeline.clips.built.start, s(16)); // pushed right after the chapter card
});

test('drop a clip to solve an overlap', () => {
  const r = demo({ 'overlap:T1:built:chapter': 'drop:built' });
  assert.equal(r.timeline.clips.built, undefined);
  assert.equal(r.conflicts.length, 2);
});

test('the same conflict id comes back on every call; a bad choice gives a clear error', () => {
  assert.deepEqual(ids(demo()), ids(demo()));
  assert.throws(() => demo({ 'delete:laptop': 'maybe' }), /conflict delete:laptop: "maybe" is not a valid choice/);
});

test('two ripples on different branches: 0 conflicts', () => {
  const base = sampleTimeline();
  const r = merge(base, rippleDelete(base, 'p2'), rippleTrimEnd(base, 'p1', s(2)));
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.timeline.clips.p3.start, s(12)); // 24 − 10 − 2
  checkTimeline(r.timeline);
});

test('two deliberate moves of the same clip: 1 conflict', () => {
  const base = sampleTimeline();
  const r = merge(base, moveClip(base, 'city', s(7)), moveClip(base, 'city', s(5)));
  assert.deepEqual(ids(r), ['edit:city:placement']);
  assert.equal(r.timeline.clips.city.start, s(7)); // ours until someone chooses
  assert.equal(merge(base, moveClip(base, 'city', s(7)), moveClip(base, 'city', s(5)), {
    choices: { 'edit:city:placement': 'theirs' },
  }).timeline.clips.city.start, s(5));
});

test('the same change on both sides is not a conflict', () => {
  const base = sampleTimeline();
  const a = setProp(base, 'title', 'text', 'Same');
  const r = merge(base, a, a);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.timeline.clips.title.props.text, 'Same');
});

test('different properties of the same clip merge by themselves', () => {
  const base = sampleTimeline();
  const r = merge(base, setProp(base, 'p1', 'grade', 'cool'), setProp(base, 'p1', 'opacity', 0.5));
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.timeline.clips.p1.props, { name: 'Point 1', grade: 'cool', opacity: 0.5 });
});

test('merge never changes its inputs, and unchanged clips stay shared', () => {
  const base = sampleTimeline();
  const ours = applySteps(base, aditiSteps);
  const theirs = applySteps(base, rahulSteps);
  const copy = JSON.stringify([base, ours, theirs]);
  const r = merge(base, ours, theirs, { choices: { 'delete:laptop': 'keep' } });
  assert.equal(JSON.stringify([base, ours, theirs]), copy);
  assert.equal(r.timeline.clips.music, base.clips.music);
});

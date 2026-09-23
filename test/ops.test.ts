import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleTimeline, FPS } from '../src/core/sample.ts';
import {
  addClip, deleteClip, moveClip, rippleDelete, rippleTrimEnd, setProp, split, toggleEffect, trimEnd,
} from '../src/core/ops.ts';
import { type Clip, type Timeline, checkTimeline, clipsOnTrack, end } from '../src/core/timeline.ts';

const s = (sec: number) => sec * FPS;

// Freezing the input makes any accidental mutation throw (modules run in strict mode).
// this help in creating a new timeline after a operation instead of mutating the old one

function frozen<T>(x: T): T {
  if (x && typeof x === 'object') {
    for (const v of Object.values(x)) frozen(v);
    Object.freeze(x);
  }
  return x;
}

const base = () => frozen(sampleTimeline());

function textClip(id: string, from: number, to: number, text: string): Clip {
  return { id, track: 'T1', start: s(from), source: 'text', in: 0, out: s(to - from), props: { name: text, text }, effects: [] };
}

test('sample project is valid and 40 seconds long', () => {
  const tl = base();
//   sampleTimeline()
//        ↓
// create sample timeline
//        ↓
// deep freeze it
//        ↓
// return timeline

  checkTimeline(tl);
  assert.equal(Object.keys(tl.clips).length, 11);
  assert.equal(end(tl.clips.outro), s(40));
  assert.deepEqual(tl.tracks.map((t) => t.name), ['Titles', 'B-roll', 'Main', 'Music']);
});

test('ripple delete p2: laptop gone, p3 at 14s, team at 17s, music still ends at 40s', () => {
  const tl = rippleDelete(base(), 'p2');
  assert.equal(tl.clips.p2, undefined);
  assert.equal(tl.clips.laptop, undefined);
  assert.equal(tl.clips.p3.start, s(14));
  assert.equal(tl.clips.outro.start, s(24));
  assert.equal(tl.clips.team.start, s(17));
  assert.equal(tl.clips.caption.start, s(25));
  assert.equal(end(tl.clips.music), s(40));
  // Clips before the cut do not move.
  assert.equal(tl.clips.city.start, s(6));
  assert.equal(tl.clips.title.start, 0);
  checkTimeline(tl);
});

test('ripple delete trims clips that cross the edges of the cut', () => {
  // Put a b-roll clip across each edge of p2 (14s..24s).
  let tl = deleteClip(base(), 'laptop');
  tl = addClip(tl, { id: 'a', track: 'V2', start: s(12), source: 'a.mp4', in: 0, out: s(4), props: {}, effects: [] });
  tl = addClip(tl, { id: 'b', track: 'V2', start: s(22), source: 'b.mp4', in: 0, out: s(4), props: {}, effects: [] });
  tl = rippleDelete(tl, 'p2');
  // a: 12..16 → keeps 12..14 (end cut off).
  assert.equal(tl.clips.a.start, s(12));
  assert.equal(tl.clips.a.out, s(2));
  // b: 22..26 → the part after 24s stays and slides to 14s; its source start moves in.
  assert.equal(tl.clips.b.start, s(14));
  assert.equal(tl.clips.b.in, s(2));
  assert.equal(tl.clips.b.out, s(4));
  checkTimeline(tl);
});

test('ripple delete shortens a clip that covers the whole cut', () => {
  let tl = deleteClip(base(), 'laptop');
  tl = addClip(tl, { id: 'long', track: 'V2', start: s(12), source: 'x.mp4', in: 0, out: s(14), props: {}, effects: [] });
  tl = rippleDelete(tl, 'p2');
  assert.equal(tl.clips.long.start, s(12));
  assert.equal(tl.clips.long.out, s(4));
});

test('ripple delete of a music clip only touches its own track and sync-locked tracks', () => {
  const tl = rippleDelete(base(), 'music');
  // The music track is not sync-locked, but it is the clip's own track;
  // the video tracks are sync-locked, so the whole 40s range is removed from them.
  assert.equal(Object.keys(tl.clips).length, 0);
});

test('ripple trim end pulls later clips left on sync-locked tracks only', () => {
  const tl = rippleTrimEnd(base(), 'intro', s(1));
  assert.equal(end(tl.clips.intro), s(3));
  assert.equal(tl.clips.p1.start, s(3));
  assert.equal(tl.clips.p3.start, s(23));
  assert.equal(tl.clips.city.start, s(5));
  assert.equal(tl.clips.caption.start, s(34));
  assert.equal(tl.clips.title.start, 0); // ends at 3s, before the cut point
  assert.equal(tl.clips.music.start, 0); // no sync lock
  assert.equal(end(tl.clips.music), s(40));
  checkTimeline(tl);
});

test('ripple trim rejects a trim that would remove the whole clip', () => {
  assert.throws(() => rippleTrimEnd(base(), 'intro', s(4)), /out must be after in/);
  assert.throws(() => rippleTrimEnd(base(), 'intro', 0), /above 0/);
});

test('delete leaves a gap', () => {
  const tl = deleteClip(base(), 'p2');
  assert.equal(tl.clips.p2, undefined);
  assert.equal(tl.clips.p3.start, s(24));
  assert.equal(tl.clips.laptop.start, s(16));
});

test('split: left keeps the id, right gets an id from the source frame', () => {
  const tl = split(base(), 'p1', s(8));
  const left = tl.clips.p1;
  const right = tl.clips[`p1@${s(8)}`];
  assert.equal(end(left), s(8));
  assert.equal(right.start, s(8));
  assert.equal(right.in, left.out);
  assert.equal(end(right), s(14));
  assert.equal(right.props.name, 'Point 1');
  // The same cut after a ripple gives the same id: the id follows the source, not the timeline.
  const rippled = split(rippleTrimEnd(base(), 'intro', s(1)), 'p1', s(7));
  assert.ok(rippled.clips[`p1@${s(8)}`]);
});

test('split point must be strictly inside the clip', () => {
  assert.throws(() => split(base(), 'p1', s(4)), /inside the clip/);
  assert.throws(() => split(base(), 'p1', s(14)), /inside the clip/);
});

test('move, set property, toggle effect, trim end', () => {
  let tl: Timeline = base();
  tl = moveClip(tl, 'city', s(7));
  assert.equal(tl.clips.city.start, s(7));
  tl = setProp(tl, 'laptop', 'opacity', 0.8);
  assert.equal(tl.clips.laptop.props.opacity, 0.8);
  tl = setProp(tl, 'laptop', 'opacity', null);
  assert.equal('opacity' in tl.clips.laptop.props, false);
  tl = toggleEffect(tl, 'p3', 'grain');
  assert.deepEqual(tl.clips.p3.effects, ['grain']);
  tl = toggleEffect(tl, 'p3', 'grain');
  assert.deepEqual(tl.clips.p3.effects, []);
  tl = trimEnd(tl, 'outro', s(1));
  assert.equal(end(tl.clips.outro), s(39));
});

test('edits refuse to create overlaps, with a clear message', () => {
  assert.throws(() => moveClip(base(), 'city', s(15)), /would overlap/);
  assert.throws(() => addClip(base(), textClip('x', 2, 5, 'Hi')), /clip x: would overlap title on track T1/);
  assert.throws(() => moveClip(base(), 'city', s(1), 'A1'), /cannot move to a audio track/);
});

test('bad input gives clear errors', () => {
  const tl = base();
  assert.throws(() => addClip(tl, { ...textClip('y', 5, 6, 'Hi'), out: 0 }), /clip y: out must be after in/);
  assert.throws(() => addClip(tl, { ...textClip('y', 5, 6, 'Hi'), start: 1.5 }), /whole frame/);
  assert.throws(() => addClip(tl, { ...textClip('y', 5, 6, 'Hi'), track: 'V9' }), /track V9 does not exist/);
  assert.throws(() => addClip(tl, textClip('title', 5, 6, 'Hi')), /already exists/);
  assert.throws(() => moveClip(tl, 'nope', 0), /clip nope: not found/);
});

test('operations never change the old timeline', () => {
  const tl = base(); // deeply frozen: any mutation would throw
  const edits = [
    () => rippleDelete(tl, 'p2'),
    () => rippleTrimEnd(tl, 'intro', s(1)),
    () => split(tl, 'p1', s(8)),
    () => setProp(tl, 'title', 'text', 'New'),
    () => toggleEffect(tl, 'p3', 'grain'),
    () => deleteClip(tl, 'city'),
    () => addClip(tl, textClip('new', 5, 6, 'Hi')),
  ];
  for (const edit of edits) assert.notEqual(edit(), tl);
  assert.deepEqual(tl, sampleTimeline());
});

test('unchanged clips are shared, not copied, between versions', () => {
  const tl = base();
  const next = setProp(tl, 'title', 'text', 'New');
  assert.equal(next.clips.p1, tl.clips.p1); // same object
  assert.notEqual(next.clips.title, tl.clips.title);
  assert.equal(clipsOnTrack(next, 'V1').length, 5);
});

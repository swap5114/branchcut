import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleTimeline } from '../src/core/sample.ts';
import { rippleDelete, setProp } from '../src/core/ops.ts';
import { MemoryObjectStore, MemoryRefStore } from '../src/core/store.ts';
import { Repo, RepoError, StaleHeadError, bucketOf } from '../src/core/repo.ts';
import { aditiSteps, applySteps, rahulSteps } from '../src/core/scenario.ts';

async function setup() {
  const store = new MemoryObjectStore();
  let now = 1000;
  const repo = new Repo(store, new MemoryRefStore(), () => now++);
  const root = await repo.init(sampleTimeline());
  return { store, repo, root };
}

test('checkout gives back exactly what was committed', async () => {
  const { repo } = await setup();
  assert.deepEqual(await repo.checkout('main'), sampleTimeline());
});

test('a one-clip edit writes exactly 4 new objects: clip, bucket, tree, commit', async () => {
  const { store, repo, root } = await setup();
  const before = store.writes;
  const tl = setProp(await repo.checkout('main'), 'title', 'text', 'Ship week');
  await repo.commit('main', tl, { expectedHead: root, message: 'Title' });
  assert.equal(store.writes - before, 4);
});

test('still 4 objects when the timeline arrives as fresh JSON (as over HTTP)', async () => {
  const { store, repo, root } = await setup();
  const before = store.writes;
  const fromWire = JSON.parse(JSON.stringify(setProp(sampleTimeline(), 'p1', 'grade', 'cool')));
  await repo.commit('main', fromWire, { expectedHead: root, message: 'Grade' });
  assert.equal(store.writes - before, 4);
});

test('same content, same hash: saving an unchanged timeline only adds a commit', async () => {
  const { store, repo, root } = await setup();
  const before = store.writes;
  await repo.commit('main', sampleTimeline(), { expectedHead: root, message: 'No change' });
  assert.equal(store.writes - before, 1);
});

test('clips spread over buckets', () => {
  const used = new Set(Array.from({ length: 1000 }, (_, i) => bucketOf(`clip-${i}`)));
  assert.equal(used.size, 64);
});

test('a stale head is refused, not overwritten', async () => {
  const { repo, root } = await setup();
  const tl = await repo.checkout('main');
  const first = await repo.commit('main', setProp(tl, 'p1', 'grade', 'cool'), { expectedHead: root, message: 'A' });
  // A second editor still thinks main is at `root`.
  await assert.rejects(
    repo.commit('main', setProp(tl, 'p1', 'grade', 'warm'), { expectedHead: root, message: 'B' }),
    (e: unknown) => e instanceof StaleHeadError && e.status === 409 && e.current === first,
  );
  assert.equal((await repo.branches()).main, first);
});

test('invalid timelines are refused with a clear message', async () => {
  const { repo, root } = await setup();
  const bad = sampleTimeline();
  bad.clips.p1 = { ...bad.clips.p1, out: bad.clips.p1.in };
  await assert.rejects(repo.commit('main', bad, { expectedHead: root, message: 'x' }), /clip p1: out must be after in/);
});

test('a small bad edit is refused too (only changed clips are checked)', async () => {
  const { repo, root } = await setup();
  const tl = await repo.checkout('main');
  // Built by hand, not with the ops, so nothing stopped the overlap earlier.
  const bad = { ...tl, clips: { ...tl.clips, p1: { ...tl.clips.p1, start: tl.clips.p1.start + 30 } } };
  await assert.rejects(repo.commit('main', bad, { expectedHead: root, message: 'x' }), /clip p1: overlaps p2 on track V1/);
  const worse = { ...tl, clips: { ...tl.clips, p1: { ...tl.clips.p1, out: 0 } } };
  await assert.rejects(repo.commit('main', worse, { expectedHead: root, message: 'x' }), /clip p1: out must be after in/);
});

test('branches, log and merge base', async () => {
  const { repo, root } = await setup();
  await repo.createBranch('aditi', 'main');
  await assert.rejects(repo.createBranch('aditi'), (e: unknown) => e instanceof RepoError && e.status === 409);
  const a1 = await repo.commit('aditi', rippleDelete(await repo.checkout('aditi'), 'p2'), { expectedHead: root, message: 'Cut p2' });
  const m1 = await repo.commit('main', setProp(await repo.checkout('main'), 'p1', 'grade', 'x'), { expectedHead: root, message: 'Grade' });
  assert.deepEqual((await repo.log('aditi')).map((c) => c.message), ['Cut p2', 'Start']);
  assert.equal(await repo.mergeBase(a1, m1), root);
  assert.equal(await repo.mergeBase(a1, root), root);
  const d = await repo.diff('main', 'aditi');
  assert.ok(d.intents.some((i) => i.text.startsWith('Ripple delete "Point 2"')));
  await assert.rejects(repo.checkout('nope'), /ref nope: not found/);
});

test('merge: up-to-date, fast-forward, then conflicts (writes nothing), then merged with 2 parents', async () => {
  const { store, repo, root } = await setup();
  await repo.createBranch('aditi');
  await repo.createBranch('rahul');
  assert.equal((await repo.merge('main', 'aditi')).status, 'up-to-date');

  let head = root;
  for (const step of aditiSteps) {
    head = await repo.commit('aditi', step.apply(await repo.checkout('aditi')), { expectedHead: head, message: step.label });
  }
  head = root;
  for (const step of rahulSteps) {
    head = await repo.commit('rahul', step.apply(await repo.checkout('rahul')), { expectedHead: head, message: step.label });
  }

  const ff = await repo.merge('main', 'aditi');
  assert.equal(ff.status, 'fast-forward');
  assert.equal((await repo.branches()).main, (await repo.branches()).aditi);

  const writes = store.writes;
  const names = { ours: 'Aditi', theirs: 'Rahul' };
  const c = await repo.merge('main', 'rahul', { names });
  assert.equal(c.status, 'conflicts');
  assert.equal(c.status === 'conflicts' && c.conflicts.length, 3);
  assert.equal(store.writes, writes); // nothing written

  const choices = {
    'edit:title:prop:text': 'theirs',
    'delete:laptop': 'delete',
    'overlap:T1:built:chapter': 'make-room',
  };
  const m = await repo.merge('main', 'rahul', { names, choices, message: 'Merge Rahul' });
  assert.equal(m.status, 'merged');
  const info = await repo.commitInfo(m.head);
  assert.equal(info.parents.length, 2);
  const merged = await repo.checkout('main');
  assert.equal(merged.clips.title.props.text, 'Launch week 2026');
  assert.deepEqual(merged.clips.p3.effects, ['grain']);
  assert.equal((await repo.merge('main', 'rahul')).status, 'up-to-date');
  // A fresh preview of the same merge gives the same timeline that was saved.
  const again = await repo.previewMerge('aditi', 'rahul', { names, choices });
  assert.deepEqual(again.status === 'merged' && again.timeline, merged);
});

test('merge refuses a stale expectedHead', async () => {
  const { repo, root } = await setup();
  await repo.createBranch('b');
  await repo.commit('main', setProp(await repo.checkout('main'), 'p1', 'grade', 'x'), { expectedHead: root, message: 'x' });
  await assert.rejects(repo.merge('main', 'b', { expectedHead: root }), StaleHeadError);
});

test('a commit hash works as a ref', async () => {
  const { repo, root } = await setup();
  await repo.commit('main', applySteps(sampleTimeline(), aditiSteps), { expectedHead: root, message: 'All' });
  assert.deepEqual(await repo.checkout(root), sampleTimeline());
});

// Integration test over real HTTP: a real server on a random port, real files in a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/server.ts';
import { sampleTimeline } from '../src/core/sample.ts';
import { aditiSteps, rahulSteps } from '../src/core/scenario.ts';
import type { Timeline } from '../src/core/timeline.ts';

test('the full story over HTTP', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'branchcut-'));
  const server = createApp({ dataDir, maxBody: 1024 * 1024 });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://localhost:${(server.address() as AddressInfo).port}/api`;
  t.after(async () => {
    server.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any, headers: res.headers };
  }

  // Create project → two branches.
  let r = await call('POST', '/projects', { id: 'launch', timeline: sampleTimeline() });
  assert.equal(r.status, 201);
  const root: string = r.body.head;
  assert.equal((await call('POST', '/projects', { id: 'launch', timeline: sampleTimeline() })).status, 409);
  assert.equal((await call('POST', '/projects/launch/branches', { name: 'aditi' })).status, 201);
  assert.equal((await call('POST', '/projects/launch/branches', { name: 'rahul' })).status, 201);
  assert.equal((await call('POST', '/projects/launch/branches', { name: 'rahul' })).status, 409);
  r = await call('GET', '/projects/launch/branches');
  assert.deepEqual(Object.keys(r.body.branches).sort(), ['aditi', 'main', 'rahul']);

  // Each editor commits their steps, always sending the head they started from.
  async function work(branch: string, steps: typeof aditiSteps) {
    let head = root;
    let tl: Timeline = (await call('GET', `/projects/launch/timeline?ref=${branch}`)).body.timeline;
    for (const step of steps) {
      tl = step.apply(tl);
      const res = await call('POST', '/projects/launch/commits', { branch, expectedHead: head, timeline: tl, message: step.label, author: branch });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      head = res.body.head;
    }
    return head;
  }
  const aditiHead = await work('aditi', aditiSteps);
  await work('rahul', rahulSteps);

  // A stale write gets 409 and the current head.
  r = await call('POST', '/projects/launch/commits', { branch: 'aditi', expectedHead: root, timeline: sampleTimeline(), message: 'late' });
  assert.equal(r.status, 409);
  assert.equal(r.body.currentHead, aditiHead);

  // Log and diff.
  r = await call('GET', '/projects/launch/log?ref=aditi');
  assert.deepEqual(r.body.commits.map((c: any) => c.message), [...aditiSteps.map((s) => s.label)].reverse().concat('Start'));
  r = await call('GET', '/projects/launch/diff?from=main&to=aditi');
  assert.ok(r.body.intents.some((i: any) => i.text.startsWith('Ripple delete "Point 2"')));

  // A commit hash is immutable, so it may be cached forever; a branch may not.
  r = await call('GET', `/projects/launch/timeline?ref=${root}`);
  assert.match(r.headers.get('cache-control') ?? '', /immutable/);
  assert.match((await call('GET', '/projects/launch/timeline?ref=main')).headers.get('cache-control') ?? '', /no-cache/);

  // Fast-forward main to Aditi.
  r = await call('POST', '/projects/launch/merge', { into: 'main', from: 'aditi' });
  assert.equal(r.body.status, 'fast-forward');

  // Conflicted merge: 409 with the list, nothing written.
  const names = { ours: 'Aditi', theirs: 'Rahul' };
  const before = (await call('GET', '/projects/launch/stats')).body.objects;
  r = await call('POST', '/projects/launch/merge', { into: 'main', from: 'rahul', names });
  assert.equal(r.status, 409);
  assert.equal(r.body.conflicts.length, 3);
  assert.equal((await call('GET', '/projects/launch/stats')).body.objects, before);

  // Same request again, with choices → merged.
  const choices = Object.fromEntries(r.body.conflicts.map((c: any) => [c.id, c.options[c.kind === 'edit-edit' ? 1 : 0]]));
  r = await call('POST', '/projects/launch/merge', { into: 'main', from: 'rahul', names, choices, message: 'Merge Rahul' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'merged');
  const merged = (await call('GET', '/projects/launch/timeline?ref=main')).body.timeline;
  assert.equal(merged.clips.title.props.text, 'Launch week 2026');
  assert.equal(merged.clips.p3.start, 13 * 30);
  r = await call('GET', '/projects/launch/log?ref=main&limit=1');
  assert.equal(r.body.commits[0].parents.length, 2);

  // Bad input gets 400 with a clear message.
  const bad = sampleTimeline();
  bad.clips.p1 = { ...bad.clips.p1, out: bad.clips.p1.in - 5 };
  const head = (await call('GET', '/projects/launch/branches')).body.branches.main;
  r = await call('POST', '/projects/launch/commits', { branch: 'main', expectedHead: head, timeline: bad });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'clip p1: out must be after in');
  r = await call('POST', '/projects/launch/commits', { branch: 'main', expectedHead: head, timeline: { ...sampleTimeline(), tracks: [{ id: 'X', name: 'X', kind: 'smell', syncLock: true }] } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /kind must be video, audio or text/);
  assert.equal((await call('POST', '/projects/launch/commits', '{not json')).status, 400);
  assert.equal((await call('POST', '/projects/launch/merge', { into: 'main', from: 'rahul', choices: { x: 1 } })).status, 400);

  // Other errors.
  assert.equal((await call('GET', '/projects/nope/log')).status, 404);
  assert.equal((await call('GET', '/projects/launch/timeline?ref=ghost')).status, 404);
  assert.equal((await call('GET', '/projects/launch/diff')).status, 400);
  assert.equal((await call('DELETE', '/projects/launch/log')).status, 405);
  assert.equal((await call('POST', '/projects', { id: '../../etc', timeline: sampleTimeline() })).status, 400);
  const huge = JSON.stringify({ id: 'big', timeline: sampleTimeline(), pad: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal((await call('POST', '/projects', huge)).status, 413);

  // Objects are real files, named by hash.
  const dirs = await readdir(join(dataDir, 'projects', 'launch', 'objects'));
  assert.ok(dirs.every((d) => /^[0-9a-f]{2}$/.test(d)));
});

test('two writers racing for the same head: exactly one wins', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'branchcut-'));
  const server = createApp({ dataDir });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://localhost:${(server.address() as AddressInfo).port}/api`;
  t.after(async () => {
    server.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const root = ((await (await post('/projects', { id: 'race', timeline: sampleTimeline() })).json()) as any).head;
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => {
      const tl = sampleTimeline();
      tl.clips.title = { ...tl.clips.title, props: { ...tl.clips.title.props, text: `Take ${i}` } };
      return post('/projects/race/commits', { branch: 'main', expectedHead: root, timeline: tl });
    }),
  );
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [201, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
});

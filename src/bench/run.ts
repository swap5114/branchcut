// The benchmark itself. No Node-only APIs, so the demo page runs the same code in the browser.

import { canonical } from '../core/canonical.ts';
import { rippleDelete, setProp } from '../core/ops.ts';
import { Repo } from '../core/repo.ts';
import { MemoryObjectStore, MemoryRefStore } from '../core/store.ts';
import { clipsOnTrack } from '../core/timeline.ts';
import { generate, rng } from './generate.ts';

export interface BenchRow {
  clips: number;
  fullCopiesBytes: number;
  storedBytes: number;
  ratio: number;
  commitMs: number;
  diffMs: number;
  mergeMs: number;
  mergeConflicts: number;
}

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function time<T>(fn: () => Promise<T> | T): Promise<[number, T]> {
  const t0 = performance.now();
  const out = await fn();
  return [performance.now() - t0, out];
}

export async function runBench(n: number, opts: { commits?: number; runs?: number } = {}): Promise<BenchRow> {
  const commits = opts.commits ?? 100;
  const runs = opts.runs ?? 15;
  const rand = rng(n);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

  const tl0 = generate(n);
  const ids = Object.keys(tl0.clips);
  const store = new MemoryObjectStore();
  const repo = new Repo(store, new MemoryRefStore());
  const root = await repo.init(tl0);

  // Storage + commit time: 100 commits that each change one clip.
  let head = root;
  let tl = tl0;
  const commitTimes: number[] = [];
  for (let i = 0; i < commits; i++) {
    tl = setProp(tl, pick(ids), 'opacity', Math.round(rand() * 100) / 100);
    const [ms, h] = await time(() => repo.commit('main', tl, { expectedHead: head, message: `edit ${i}` }));
    commitTimes.push(ms);
    head = h;
  }
  const fullCopiesBytes = canonical(tl0).length * (commits + 1);
  const storedBytes = (await store.stats()).bytes;

  // Two branches: each ripple-deletes a main-track clip and changes 20 other clips.
  const main = clipsOnTrack(tl0, 'V1');
  const setup = async (branch: string, cut: string, pool: string[]) => {
    await repo.createBranch(branch, root);
    let t = rippleDelete(tl0, cut);
    for (let i = 0; i < 20; i++) {
      const id = pool[Math.floor(rand() * pool.length)];
      if (t.clips[id]) t = setProp(t, id, 'grade', `${branch}-${i}`);
    }
    return repo.commit(branch, t, { expectedHead: root, message: `${branch} edits` });
  };
  // Disjoint halves of the main track, so the two editors do not touch the same clips.
  const half = main.length >> 1;
  const a = await setup('a', main[Math.floor(half / 2)].id, main.slice(0, half).map((c) => c.id));
  const b = await setup('b', main[half + Math.floor(half / 2)].id, main.slice(half).map((c) => c.id));

  const diffTimes: number[] = [];
  const mergeTimes: number[] = [];
  let mergeConflicts = 0;
  for (let i = 0; i < runs; i++) {
    diffTimes.push((await time(() => repo.diff(root, a)))[0]);
    const [ms, out] = await time(() => repo.previewMerge(a, b));
    mergeTimes.push(ms);
    mergeConflicts = out.status === 'conflicts' ? out.conflicts.length : 0;
  }

  return {
    clips: n,
    fullCopiesBytes,
    storedBytes,
    ratio: fullCopiesBytes / storedBytes,
    commitMs: median(commitTimes),
    diffMs: median(diffTimes),
    mergeMs: median(mergeTimes),
    mergeConflicts,
  };
}

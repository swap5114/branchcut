// The repository: content-addressed objects plus branch refs, like git.
//
//   commit → tree (fps, tracks, 64 bucket hashes) → bucket (clip id → clip hash) → clip
//
// Every object is stored under the SHA-256 of its canonical JSON, so the same
// content is stored once. A one-clip edit writes 4 objects: the clip, its
// bucket, the tree and the commit. The other 63 buckets are reused by hash.

import { canonical } from './canonical.ts';
import { type ClipChange, changedGroups, diff } from './diff.ts';
import { type Intent, intents } from './intents.ts';
import { type MergeOptions, type MergeResult, merge } from './merge.ts';
import { sha256 } from './sha256.ts';
import type { ObjectStore, RefStore } from './store.ts';
import { type Clip, type Timeline, type Track, checkClip, checkTimeline, overlapWith } from './timeline.ts';

export const BUCKETS = 64;

interface CommitObj { type: 'commit'; tree: string; parents: string[]; message: string; author: string; time: number }
interface TreeObj { type: 'tree'; fps: number; tracks: Track[]; buckets: string[] }
interface BucketObj { type: 'bucket'; clips: Record<string, string> }
interface ClipObj { type: 'clip'; clip: Clip }
type Obj = CommitObj | TreeObj | BucketObj | ClipObj;

export interface CommitInfo { hash: string; parents: string[]; message: string; author: string; time: number }

/** Errors carry an HTTP-like status so the server can map them without guessing. */
export class RepoError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class StaleHeadError extends RepoError {
  branch: string;
  current: string | null;
  constructor(branch: string, expected: string | null, current: string | null) {
    super(409, `branch ${branch}: stale head (expected ${short(expected)}, but it is now ${short(current)})`);
    this.branch = branch;
    this.current = current;
  }
}

const short = (h: string | null) => (h ? h.slice(0, 8) : 'nothing');
const HASH = /^[0-9a-f]{64}$/;

/** Cheap, stable string hash (FNV-1a) to pick a clip's bucket. Not for security, only for spreading. */
export function bucketOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % BUCKETS;
}

/** A checked-out commit, with what we need to save the next commit cheaply. */
interface State {
  timeline: Timeline;
  buckets: string[];
  /** Per bucket: clip id → clip hash. Never changed after saving; a new commit copies the buckets it touches. */
  bucketMaps: Record<string, string>[];
}

export type MergeOutcome =
  | { status: 'up-to-date'; head: string }
  | { status: 'fast-forward'; head: string }
  | ({ status: 'conflicts'; head: string; base: string } & MergeResult)
  | ({ status: 'merged'; head: string; base: string } & MergeResult);

export class Repo {
  /** Parsed objects by hash. Objects never change, so a cached copy is always right. */
  private objects = new Map<string, Obj>();
  /** Clip object → its hash. Edits share unchanged clip objects, so most lookups hit. */
  private clipHash = new WeakMap<Clip, string>();
  /** The last few checked-out commits. */
  private states = new Map<string, State>();
  private store: ObjectStore;
  private refs: RefStore;
  private clock: () => number;

  constructor(store: ObjectStore, refs: RefStore, clock: () => number = Date.now) {
    this.store = store;
    this.refs = refs;
    this.clock = clock;
  }

  // ---------- objects ----------

  private async write(obj: Obj): Promise<string> {
    const json = canonical(obj);
    const hash = sha256(json);
    await this.store.put(hash, json);
    this.remember(hash, obj);
    return hash;
  }

  private async read<T extends Obj>(hash: string, type: T['type']): Promise<T> {
    let obj = this.objects.get(hash);
    if (!obj) {
      const json = await this.store.get(hash);
      if (json === null) throw new RepoError(404, `object ${short(hash)}: not found`);
      obj = JSON.parse(json) as Obj;
      this.remember(hash, obj);
    }
    if (obj.type !== type) throw new RepoError(404, `object ${short(hash)}: is a ${obj.type}, not a ${type}`);
    return obj as T;
  }

  private remember(hash: string, obj: Obj) {
    // A simple cap keeps a long-running server from growing forever.
    if (this.objects.size > 500_000) this.objects.clear();
    this.objects.set(hash, obj);
  }

  // ---------- timelines ----------

  private async load(commit: string): Promise<State> {
    const hit = this.states.get(commit);
    if (hit) {
      this.states.delete(commit); // re-insert = most recently used
      this.states.set(commit, hit);
      return hit;
    }
    const c = await this.read<CommitObj>(commit, 'commit');
    const tree = await this.read<TreeObj>(c.tree, 'tree');
    const clips: Record<string, Clip> = {};
    const bucketMaps: Record<string, string>[] = [];
    for (const bh of tree.buckets) {
      const bucket = await this.read<BucketObj>(bh, 'bucket');
      bucketMaps.push(bucket.clips);
      for (const [id, h] of Object.entries(bucket.clips)) {
        // Cached objects are used directly: an await per clip costs more than the lookup itself.
        const cached = this.objects.get(h);
        const clip = (cached?.type === 'clip' ? cached : await this.read<ClipObj>(h, 'clip')).clip;
        clips[id] = clip;
        this.clipHash.set(clip, h);
      }
    }
    return this.cacheState(commit, { timeline: { fps: tree.fps, tracks: tree.tracks, clips }, buckets: tree.buckets, bucketMaps });
  }

  private cacheState(commit: string, state: State): State {
    this.states.set(commit, state);
    if (this.states.size > 8) this.states.delete(this.states.keys().next().value!);
    return state;
  }

  /**
   * Writes the timeline's objects, reusing everything that did not change since `parent`.
   * Edits share unchanged clip objects, so "changed" is an identity check (!==):
   * a one-clip edit only hashes, checks and re-buckets that one clip.
   */
  private async saveTree(tl: Timeline, parent: string | null): Promise<{ tree: string; state: State }> {
    const prev = parent ? await this.load(parent) : null;
    const sameShape = !!prev && prev.timeline.fps === tl.fps && canonical(prev.timeline.tracks) === canonical(tl.tracks);
    let changed: [string, Clip][] = [];
    const removed: string[] = [];
    if (prev && sameShape) {
      for (const id in tl.clips) if (prev.timeline.clips[id] !== tl.clips[id]) changed.push([id, tl.clips[id]]);
      for (const id in prev.timeline.clips) if (!(id in tl.clips)) removed.push(id);
    }
    // Small edits: check only the changed clips. Big ones (a ripple, or a timeline
    // that arrived as JSON, where every object is new): check everything.
    const incremental = sameShape && changed.length <= 64;
    try {
      if (incremental) {
        for (const [id, c] of changed) {
          if (c.id !== id) throw new Error(`clip ${id}: stored under a different id (${c.id})`);
          checkClip(tl, c);
          const o = overlapWith(tl, c);
          if (o) throw new Error(`clip ${c.id}: overlaps ${o.id} on track ${c.track}`);
        }
      } else checkTimeline(tl);
    } catch (e) {
      throw new RepoError(400, (e as Error).message);
    }

    let maps: Record<string, string>[];
    let dirty: Set<number>;
    if (incremental) {
      dirty = new Set([...changed.map(([id]) => bucketOf(id)), ...removed.map(bucketOf)]);
      maps = prev!.bucketMaps.map((m, i) => (dirty.has(i) ? { ...m } : m));
      for (const id of removed) delete maps[bucketOf(id)][id];
    } else {
      dirty = new Set(Array.from({ length: BUCKETS }, (_, i) => i));
      maps = Array.from({ length: BUCKETS }, () => ({}));
      changed = Object.entries(tl.clips);
    }
    for (const [id, clip] of changed) {
      let h = this.clipHash.get(clip);
      if (!h) {
        // A clip that came from outside (for example, JSON over HTTP) is a new
        // object. If it equals the parent's clip, reuse that hash: comparing
        // fields is much cheaper than hashing.
        const old = prev?.timeline.clips[id];
        if (old && changedGroups(old, clip).length === 0) h = prev!.bucketMaps[bucketOf(id)][id];
        else h = await this.write({ type: 'clip', clip });
        this.clipHash.set(clip, h);
      }
      maps[bucketOf(id)][id] = h;
    }
    const buckets: string[] = [];
    for (let i = 0; i < BUCKETS; i++) {
      if (prev && (!dirty.has(i) || sameMap(prev.bucketMaps[i], maps[i]))) {
        maps[i] = prev.bucketMaps[i];
        buckets.push(prev.buckets[i]);
      } else {
        buckets.push(await this.write({ type: 'bucket', clips: maps[i] }));
      }
    }
    const tree = await this.write({ type: 'tree', fps: tl.fps, tracks: tl.tracks, buckets });
    return { tree, state: { timeline: tl, buckets, bucketMaps: maps } };
  }

  private async writeCommit(tl: Timeline, parents: string[], message: string, author: string): Promise<string> {
    const { tree, state } = await this.saveTree(tl, parents[0] ?? null);
    const hash = await this.write({ type: 'commit', tree, parents, message, author, time: this.clock() });
    // The next commit on this branch will ask for this one as its parent.
    this.cacheState(hash, state);
    return hash;
  }

  // ---------- refs ----------

  /** A branch name or a full commit hash → commit hash. */
  async resolve(ref: string): Promise<string> {
    if (HASH.test(ref)) {
      await this.read<CommitObj>(ref, 'commit');
      return ref;
    }
    const h = await this.refs.get(ref);
    if (!h) throw new RepoError(404, `ref ${ref}: not found`);
    return h;
  }

  async branches(): Promise<Record<string, string>> {
    return this.refs.all();
  }

  /** Creates `main` with a first commit. */
  async init(tl: Timeline, message = 'Start', author = 'system'): Promise<string> {
    if (await this.refs.get('main')) throw new RepoError(409, 'branch main: already exists');
    const hash = await this.writeCommit(tl, [], message, author);
    if (!(await this.refs.cas('main', null, hash))) throw new RepoError(409, 'branch main: already exists');
    return hash;
  }

  async createBranch(name: string, from = 'main'): Promise<string> {
    const hash = await this.resolve(from);
    if (!(await this.refs.cas(name, null, hash))) throw new RepoError(409, `branch ${name}: already exists`);
    return hash;
  }

  async resetBranch(name: string, to: string, expectedHead: string): Promise<string> {
    const hash = await this.resolve(to);
    if (!(await this.refs.cas(name, expectedHead, hash))) {
      throw new StaleHeadError(name, expectedHead, await this.refs.get(name));
    }
    return hash;
  }

  /**
   * Saves a new version on `branch`. `expectedHead` is the commit the editor
   * started from. If the branch moved since then, we refuse instead of
   * silently overwriting the other person's work.
   */
  async commit(branch: string, tl: Timeline, o: { expectedHead: string; message: string; author?: string }): Promise<string> {
    const current = await this.refs.get(branch);
    if (!current) throw new RepoError(404, `branch ${branch}: not found`);
    if (current !== o.expectedHead) throw new StaleHeadError(branch, o.expectedHead, current);
    const hash = await this.writeCommit(tl, [current], o.message, o.author ?? 'unknown');
    // If someone moved the branch while we were writing, the objects we wrote
    // are simply unused (like in git). The ref is the only thing that must not race.
    if (!(await this.refs.cas(branch, current, hash))) {
      throw new StaleHeadError(branch, o.expectedHead, await this.refs.get(branch));
    }
    return hash;
  }

  // ---------- reading history ----------

  async checkout(ref: string): Promise<Timeline> {
    return (await this.load(await this.resolve(ref))).timeline;
  }

  async commitInfo(hash: string): Promise<CommitInfo> {
    const c = await this.read<CommitObj>(hash, 'commit');
    return { hash, parents: c.parents, message: c.message, author: c.author, time: c.time };
  }

  /** All commits reachable from `ref`, newest first. */
  async log(ref: string, limit = 100): Promise<CommitInfo[]> {
    const seen = new Set<string>();
    const out: CommitInfo[] = [];
    const queue = [await this.resolve(ref)];
    while (queue.length) {
      const h = queue.shift()!;
      if (seen.has(h)) continue;
      seen.add(h);
      const info = await this.commitInfo(h);
      out.push(info);
      queue.push(...info.parents);
    }
    out.sort((a, b) => b.time - a.time || (a.hash < b.hash ? -1 : 1));
    return out.slice(0, limit);
  }

  /**
   * Nearest common ancestor: every ancestor of `a`, then walk back from `b`
   * breadth-first and stop at the first one we meet. Known limit: with
   * criss-cross merges there can be two equally good answers; git merges
   * them into a virtual base, we just take the first.
   */
  async mergeBase(a: string, b: string): Promise<string | null> {
    const ofA = new Set<string>();
    const queue = [a];
    while (queue.length) {
      const h = queue.shift()!;
      if (ofA.has(h)) continue;
      ofA.add(h);
      queue.push(...(await this.read<CommitObj>(h, 'commit')).parents);
    }
    const seen = new Set<string>();
    const q2 = [b];
    while (q2.length) {
      const h = q2.shift()!;
      if (ofA.has(h)) return h;
      if (seen.has(h)) continue;
      seen.add(h);
      q2.push(...(await this.read<CommitObj>(h, 'commit')).parents);
    }
    return null;
  }

  async diff(from: string, to: string): Promise<{ changes: ClipChange[]; intents: Intent[] }> {
    const [a, b] = [await this.checkout(from), await this.checkout(to)];
    const changes = diff(a, b);
    return { changes, intents: intents(a, b, changes) };
  }

  // ---------- merge ----------

  /** Computes the merge of `from` into `into` without writing anything. */
  async previewMerge(into: string, from: string, opts: MergeOptions = {}): Promise<MergeOutcome> {
    const head = await this.resolve(into);
    const theirs = await this.resolve(from);
    const base = await this.mergeBase(head, theirs);
    if (!base) throw new RepoError(409, `${into} and ${from} have no common history`);
    if (base === theirs) return { status: 'up-to-date', head };
    if (base === head) return { status: 'fast-forward', head: theirs };
    const result = merge(await this.checkout(base), await this.checkout(head), await this.checkout(theirs), opts);
    return { status: result.conflicts.length ? 'conflicts' : 'merged', head, base, ...result };
  }

  /**
   * Merges `from` into branch `into`. Writes nothing while any conflict has
   * no choice: the caller sends the same request again with choices.
   */
  async merge(
    into: string, from: string,
    o: MergeOptions & { expectedHead?: string; message?: string; author?: string } = {},
  ): Promise<MergeOutcome> {
    const head = await this.refs.get(into);
    if (!head) throw new RepoError(404, `branch ${into}: not found`);
    if (o.expectedHead !== undefined && o.expectedHead !== head) throw new StaleHeadError(into, o.expectedHead, head);
    const out = await this.previewMerge(into, from, o);
    if (out.status === 'up-to-date' || out.status === 'conflicts') return out;
    if (out.status === 'fast-forward') {
      if (!(await this.refs.cas(into, head, out.head))) throw new StaleHeadError(into, head, await this.refs.get(into));
      return out;
    }
    const theirs = await this.resolve(from);
    const hash = await this.writeCommit(out.timeline, [head, theirs], o.message ?? `Merge ${from} into ${into}`, o.author ?? 'unknown');
    if (!(await this.refs.cas(into, head, hash))) throw new StaleHeadError(into, head, await this.refs.get(into));
    return { ...out, head: hash };
  }

  async stats() {
    return this.store.stats();
  }
}

function sameMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

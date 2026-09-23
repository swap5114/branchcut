// File storage for one project.
//   <dir>/objects/ab/cdef….json   one file per object, named by its hash
//   <dir>/refs.json               branch name → commit hash

import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { ObjectStore, RefStore } from '../core/store.ts';

const HASH = /^[0-9a-f]{64}$/;

/**
 * Write to a temp file, then rename. Rename is atomic on one disk: a reader
 * sees the old file or the new one, never half a file, even if we crash midway.
 */
async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

export class FileObjectStore implements ObjectStore {
  private dir: string;
  /** Hashes we know are on disk. Objects never change, so this never goes stale. */
  private known = new Set<string>();

  constructor(dir: string) {
    this.dir = join(dir, 'objects');
  }

  private path(hash: string): string {
    // The hash becomes part of a file path, so it must be exactly 64 hex characters.
    if (!HASH.test(hash)) throw new Error(`bad object hash: ${hash}`);
    return join(this.dir, hash.slice(0, 2), `${hash.slice(2)}.json`);
  }

  async get(hash: string): Promise<string | null> {
    try {
      const data = await readFile(this.path(hash), 'utf8');
      this.known.add(hash);
      return data;
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  async put(hash: string, data: string): Promise<boolean> {
    if (this.known.has(hash)) return false;
    const p = this.path(hash);
    try {
      await stat(p);
      this.known.add(hash);
      return false;
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
    // Two requests may write the same object at once. Both write the same
    // bytes, so whichever rename lands last is still correct.
    await writeAtomic(p, data);
    this.known.add(hash);
    return true;
  }

  async stats() {
    let objects = 0;
    let bytes = 0;
    let dirs: string[] = [];
    try {
      dirs = await readdir(this.dir);
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
    for (const d of dirs) {
      for (const f of await readdir(join(this.dir, d))) {
        if (!f.endsWith('.json')) continue;
        objects++;
        bytes += (await stat(join(this.dir, d, f))).size;
      }
    }
    return { objects, bytes };
  }
}

/**
 * Refs in one small JSON file, changed only by compare-and-set.
 *
 * One process: a promise queue makes each read-compare-write run alone, so two
 * requests can never both see the old head and both win.
 *
 * Many servers: an in-process queue is not enough. The refs move to a database
 * and compare-and-set becomes one atomic statement:
 *
 *   UPDATE refs SET head = $next
 *   WHERE project = $p AND name = $branch AND head = $expected;
 *
 * If it updates 0 rows, someone moved the branch first: reply 409 with the
 * current head. The objects can stay in files or move to S3; they never change,
 * so they need no locking at all.
 */
export class FileRefStore implements RefStore {
  private file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.file = join(dir, 'refs.json');
  }

  private async read(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8'));
    } catch (e) {
      if (isMissing(e)) return {};
      throw e;
    }
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async exists(): Promise<boolean> {
    try {
      await stat(this.file);
      return true;
    } catch (e) {
      if (isMissing(e)) return false;
      throw e;
    }
  }

  get(name: string) {
    return this.locked(async () => (await this.read())[name] ?? null);
  }

  all() {
    return this.locked(() => this.read());
  }

  cas(name: string, expected: string | null, next: string) {
    return this.locked(async () => {
      const refs = await this.read();
      if ((refs[name] ?? null) !== expected) return false;
      refs[name] = next;
      await writeAtomic(this.file, JSON.stringify(refs, null, 2));
      return true;
    });
  }
}

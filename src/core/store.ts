// Where the repo keeps its data. Two small interfaces, so the same repo code
// runs on memory (tests, browser) and on files (server).
// They are async because real storage (disk, network, a database) is.

export interface ObjectStore {
  get(hash: string): Promise<string | null>;
  /** Writes the object if it is not there yet. Returns true if it was new. */
  put(hash: string, data: string): Promise<boolean>;
  stats(): Promise<{ objects: number; bytes: number }>;
}

export interface RefStore {
  get(name: string): Promise<string | null>;
  all(): Promise<Record<string, string>>;
  /**
   * Compare-and-set: point `name` at `next` only if it points at `expected` now
   * (null = the ref must not exist yet). Returns false if someone moved it first.
   */
  cas(name: string, expected: string | null, next: string): Promise<boolean>;
}

export class MemoryObjectStore implements ObjectStore {
  private data = new Map<string, string>();
  private bytes = 0;
  /** How many new objects were written. Tests use it to check what an edit costs. */
  writes = 0;

  async get(hash: string) {
    return this.data.get(hash) ?? null;
  }

  async put(hash: string, data: string) {
    if (this.data.has(hash)) return false;
    this.data.set(hash, data);
    this.bytes += data.length;
    this.writes++;
    return true;
  }

  async stats() {
    return { objects: this.data.size, bytes: this.bytes };
  }
}

export class MemoryRefStore implements RefStore {
  private refs = new Map<string, string>();

  async get(name: string) {
    return this.refs.get(name) ?? null;
  }

  async all() {
    return Object.fromEntries(this.refs);
  }

  async cas(name: string, expected: string | null, next: string) {
    // JavaScript runs one piece of code at a time, and there is no await
    // between the check and the write, so nothing can slip in between.
    if ((this.refs.get(name) ?? null) !== expected) return false;
    this.refs.set(name, next);
    return true;
  }
}

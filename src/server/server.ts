// The HTTP API, on plain node:http so every step is visible:
// match the route → read and check the body → call the repo → send JSON.
//
// Stateless: a merge with open conflicts returns 409 with the conflict list.
// The client sends the same request again with `choices`. The server keeps
// nothing between the two calls.

import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Repo, RepoError, StaleHeadError } from '../core/repo.ts';
import { FileObjectStore, FileRefStore } from './fileStore.ts';
import * as v from './validate.ts';

export interface ServerOptions {
  dataDir: string;
  /** Biggest request body we accept. A 20,000-clip timeline is about 5 MB. */
  maxBody?: number;
}

interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

type Handler = (ctx: { p: string; repo: Repo; url: URL; body: () => Promise<Record<string, unknown>> }) => Promise<Reply>;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const HASH = /^[0-9a-f]{64}$/;

export function createApp(opts: ServerOptions) {
  const maxBody = opts.maxBody ?? 8 * 1024 * 1024;
  const repos = new Map<string, { repo: Repo; refs: FileRefStore }>();

  function open(p: string) {
    let r = repos.get(p);
    if (!r) {
      const dir = join(opts.dataDir, 'projects', p);
      const refs = new FileRefStore(dir);
      r = { repo: new Repo(new FileObjectStore(dir), refs), refs };
      repos.set(p, r);
    }
    return r;
  }

  const ok = (body: unknown, status = 200): Reply => ({ status, body });

  // ---------- routes ----------

  const createProject = async (body: Record<string, unknown>): Promise<Reply> => {
    const id = v.str(body.id, 'id', v.PROJECT_ID);
    const tl = v.timeline(body.timeline);
    const { repo, refs } = open(id);
    if (await refs.exists()) throw new HttpError(409, `project ${id}: already exists`);
    await mkdir(join(opts.dataDir, 'projects', id), { recursive: true });
    const head = await repo.init(tl, v.optStr(body.message, 'message') ?? 'Start', v.optStr(body.author, 'author'));
    return ok({ id, head }, 201);
  };

  const routes: [string, RegExp, Handler][] = [
    ['GET', /^branches$/, async ({ repo }) => ok({ branches: await repo.branches() })],

    ['POST', /^branches$/, async ({ repo, body }) => {
      const b = await body();
      const name = v.str(b.name, 'name', v.BRANCH);
      const head = await repo.createBranch(name, v.optStr(b.from, 'from') ?? 'main');
      return ok({ name, head }, 201);
    }],

    ['GET', /^timeline$/, async ({ repo, url }) => {
      const ref = url.searchParams.get('ref') ?? 'main';
      const commit = await repo.resolve(ref);
      // A commit hash always means the same timeline, so it can be cached forever.
      // A branch name moves, so it must be asked again every time.
      const headers = HASH.test(ref)
        ? { 'cache-control': 'public, max-age=31536000, immutable' }
        : { 'cache-control': 'no-cache' };
      return { status: 200, body: { ref, commit, timeline: await repo.checkout(commit) }, headers };
    }],

    ['POST', /^commits$/, async ({ repo, body }) => {
      const b = await body();
      const branch = v.str(b.branch, 'branch', v.BRANCH);
      const expectedHead = v.str(b.expectedHead, 'expectedHead', HASH);
      const head = await repo.commit(branch, v.timeline(b.timeline), {
        expectedHead,
        message: v.optStr(b.message, 'message') ?? 'Edit',
        author: v.optStr(b.author, 'author'),
      });
      return ok({ branch, head }, 201);
    }],

    ['GET', /^log$/, async ({ repo, url }) => {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 500);
      return ok({ commits: await repo.log(url.searchParams.get('ref') ?? 'main', limit) });
    }],

    ['GET', /^diff$/, async ({ repo, url }) => {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!from || !to) throw new HttpError(400, 'diff needs ?from= and ?to=');
      const d = await repo.diff(from, to);
      return ok({
        from, to,
        intents: d.intents,
        changes: d.changes.map((c) => ({ id: c.id, kind: c.kind, groups: c.kind === 'modified' ? c.groups : [] })),
      });
    }],

    ['POST', /^merge$/, async ({ repo, body }) => {
      const b = await body();
      const names = b.names === undefined ? undefined : v.obj(b.names, 'names');
      const out = await repo.merge(v.str(b.into, 'into', v.BRANCH), v.str(b.from, 'from'), {
        choices: v.choices(b.choices),
        names: names && { ours: v.str(names.ours, 'names.ours'), theirs: v.str(names.theirs, 'names.theirs') },
        expectedHead: b.expectedHead === undefined ? undefined : v.str(b.expectedHead, 'expectedHead', HASH),
        message: v.optStr(b.message, 'message'),
        author: v.optStr(b.author, 'author'),
      });
      if (out.status === 'conflicts') {
        const { status, head, base, conflicts, resolved, notes } = out;
        return { status: 409, body: { status, head, base, conflicts, resolved, notes, error: `${conflicts.length} conflicts need a choice` } };
      }
      if (out.status === 'merged') {
        const { status, head, base, notes, resolved } = out;
        return ok({ status, head, base, notes, resolved });
      }
      return ok(out);
    }],

    ['GET', /^stats$/, async ({ repo }) => {
      const s = await repo.stats();
      return ok({ ...s, branches: Object.keys(await repo.branches()).length });
    }],
  ];

  // ---------- plumbing ----------

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (Number(req.headers['content-length'] ?? 0) > maxBody) throw new HttpError(413, `body is larger than ${maxBody} bytes`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      // Checked while reading too: content-length can be missing or wrong.
      if (size > maxBody) throw new HttpError(413, `body is larger than ${maxBody} bytes`);
      chunks.push(chunk as Buffer);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
    } catch {
      throw new HttpError(400, 'body is not valid JSON');
    }
    return v.obj(parsed);
  }

  async function handle(req: IncomingMessage): Promise<Reply> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    if (url.pathname === '/api/projects') {
      if (method !== 'POST') throw new HttpError(405, 'use POST to create a project');
      return createProject(await readJson(req));
    }
    const m = /^\/api\/projects\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (!m) throw new HttpError(404, `no route for ${method} ${url.pathname}`);
    const p = decodeURIComponent(m[1]);
    if (!v.PROJECT_ID.test(p)) throw new HttpError(400, 'project id has characters that are not allowed');
    const route = routes.find(([rm, re]) => re.test(m[2]) && rm === method);
    if (!route) {
      const exists = routes.some(([, re]) => re.test(m[2]));
      throw new HttpError(exists ? 405 : 404, `no route for ${method} ${url.pathname}`);
    }
    // Check before open(): caching a repo for every made-up id would let anyone fill our memory.
    if (!repos.has(p) && !(await new FileRefStore(join(opts.dataDir, 'projects', p)).exists())) {
      throw new HttpError(404, `project ${p}: not found`);
    }
    return route[2]({ p, repo: open(p).repo, url, body: () => readJson(req) });
  }

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let reply: Reply;
    try {
      reply = await handle(req);
    } catch (e) {
      if (e instanceof StaleHeadError) {
        reply = { status: 409, body: { error: e.message, currentHead: e.current } };
      } else if (e instanceof RepoError || e instanceof HttpError || e instanceof v.BadRequest) {
        reply = { status: e.status, body: { error: e.message } };
      } else {
        // Unknown errors are bugs: log them, but never send internals to the client.
        console.error(e);
        reply = { status: 500, body: { error: 'internal error' } };
      }
    }
    const json = JSON.stringify(reply.body);
    res.writeHead(reply.status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(json),
      ...reply.headers,
    });
    res.end(json);
  });
}

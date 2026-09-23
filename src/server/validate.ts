// Input checks for the API. Everything from the network is untrusted:
// check the shape here, then the timeline rules (overlaps, out after in)
// run in the core when the commit is saved.

import type { Clip, Timeline, Track } from '../core/timeline.ts';

export class BadRequest extends Error {
  status = 400;
}

const fail = (msg: string): never => {
  throw new BadRequest(msg);
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export function obj(x: unknown, what = 'body'): Record<string, unknown> {
  return isObj(x) ? x : fail(`${what} must be a JSON object`);
}

export function str(x: unknown, what: string, pattern?: RegExp): string {
  if (typeof x !== 'string' || x === '') return fail(`${what} must be a non-empty string`);
  if (x.length > 500) return fail(`${what} is too long`);
  if (pattern && !pattern.test(x)) return fail(`${what} has characters that are not allowed`);
  return x;
}

export function optStr(x: unknown, what: string): string | undefined {
  return x === undefined ? undefined : str(x, what);
}

export const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const KINDS = new Set(['video', 'audio', 'text']);

export function timeline(x: unknown): Timeline {
  const t = obj(x, 'timeline');
  if (typeof t.fps !== 'number') fail('timeline.fps must be a number');
  if (!Array.isArray(t.tracks)) fail('timeline.tracks must be a list');
  const tracks = (t.tracks as unknown[]).map((raw, i): Track => {
    const tr = obj(raw, `timeline.tracks[${i}]`);
    const kind = tr.kind as string;
    if (!KINDS.has(kind)) fail(`track ${String(tr.id)}: kind must be video, audio or text`);
    if (typeof tr.syncLock !== 'boolean') fail(`track ${String(tr.id)}: syncLock must be true or false`);
    return {
      id: str(tr.id, `timeline.tracks[${i}].id`),
      name: str(tr.name, `track ${String(tr.id)}: name`),
      kind: kind as Track['kind'],
      syncLock: tr.syncLock as boolean,
    };
  });
  const rawClips = obj(t.clips, 'timeline.clips');
  const clips: Record<string, Clip> = {};
  for (const [key, raw] of Object.entries(rawClips)) {
    const c = obj(raw, `clip ${key}`);
    const props = obj(c.props ?? {}, `clip ${key}: props`);
    for (const [k, v] of Object.entries(props)) {
      if (!['string', 'number', 'boolean'].includes(typeof v)) fail(`clip ${key}: prop ${k} must be a string, number or boolean`);
    }
    if (!Array.isArray(c.effects ?? [])) fail(`clip ${key}: effects must be a list`);
    for (const f of ['start', 'in', 'out'] as const) {
      if (typeof c[f] !== 'number') fail(`clip ${key}: ${f} must be a number`);
    }
    // Only known fields are kept: extra fields would change the hash without meaning anything.
    clips[key] = {
      id: str(c.id, `clip ${key}: id`),
      track: str(c.track, `clip ${key}: track`),
      start: c.start as number,
      source: str(c.source, `clip ${key}: source`),
      in: c.in as number,
      out: c.out as number,
      props: props as Clip['props'],
      effects: (c.effects ?? []) as string[],
    };
  }
  return { fps: t.fps as number, tracks, clips };
}

export function choices(x: unknown): Record<string, string> {
  if (x === undefined) return {};
  const c = obj(x, 'choices');
  for (const [k, v] of Object.entries(c)) if (typeof v !== 'string') fail(`choices.${k} must be a string`);
  return c as Record<string, string>;
}

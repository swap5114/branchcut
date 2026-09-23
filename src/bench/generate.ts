// Big projects for the benchmark: n clips over the 4 tracks of the sample
// project, laid out like a real edit (a full main track, b-roll and titles
// with gaps, long music beds). Seeded, so every run gets the same project.

import type { Clip, Timeline } from '../core/timeline.ts';

/** Small seeded random number generator (mulberry32). */
export function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generate(n: number, seed = 1): Timeline {
  const rand = rng(seed);
  const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const fps = 30;
  // [track, share of clips, gap range (s), length range (s), source]
  const plan: [string, number, [number, number], [number, number], string][] = [
    ['V1', 0.5, [0, 0], [2, 6], 'interview.mp4'],
    ['V2', 0.25, [1, 8], [2, 4], 'broll'],
    ['T1', 0.15, [2, 10], [2, 4], 'text'],
    ['A1', 0.1, [0, 0], [20, 60], 'music'],
  ];
  const clips: Record<string, Clip> = {};
  let left = n;
  plan.forEach(([track, share, gap, len, source], i) => {
    const count = i === plan.length - 1 ? left : Math.round(n * share);
    left -= count;
    let t = 0;
    for (let k = 0; k < count; k++) {
      t += between(gap[0], gap[1]) * fps;
      const d = between(len[0] * fps, len[1] * fps);
      const id = `${track.toLowerCase()}-${k}`;
      const src = source === 'broll' ? `broll-${k % 50}.mp4` : source === 'music' ? `music-${k % 10}.mp3` : source;
      const props: Clip['props'] = { name: `${track} ${k}` };
      if (source === 'text') props.text = `Title ${k}`;
      clips[id] = { id, track, start: t, source: src, in: source === 'interview.mp4' ? t : 0, out: (source === 'interview.mp4' ? t : 0) + d, props, effects: [] };
      t += d;
    }
  });
  return {
    fps,
    tracks: [
      { id: 'T1', name: 'Titles', kind: 'text', syncLock: true },
      { id: 'V2', name: 'B-roll', kind: 'video', syncLock: true },
      { id: 'V1', name: 'Main', kind: 'video', syncLock: true },
      { id: 'A1', name: 'Music', kind: 'audio', syncLock: false },
    ],
    clips,
  };
}

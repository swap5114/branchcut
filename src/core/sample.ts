// The sample project: a 40-second talking-head cut at 30 fps.
// Tests, the benchmark and the demo all start from this one timeline.

import type { Clip, PropValue, Timeline } from './timeline.ts';

export const FPS = 30;
const s = (seconds: number) => Math.round(seconds * FPS);

function clip(
  id: string, track: string, from: number, to: number,
  source: string, srcIn: number, props: Record<string, PropValue>,
): Clip {
  return { id, track, start: s(from), source, in: s(srcIn), out: s(srcIn + to - from), props, effects: [] };
}

export function sampleTimeline(): Timeline {
  const clips: Clip[] = [
    clip('intro', 'V1', 0, 4, 'interview.mp4', 0, { name: 'Intro' }),
    clip('p1', 'V1', 4, 14, 'interview.mp4', 4, { name: 'Point 1' }),
    clip('p2', 'V1', 14, 24, 'interview.mp4', 14, { name: 'Point 2' }),
    clip('p3', 'V1', 24, 34, 'interview.mp4', 24, { name: 'Point 3' }),
    clip('outro', 'V1', 34, 40, 'interview.mp4', 34, { name: 'Outro' }),
    clip('city', 'V2', 6, 9, 'city.mp4', 0, { name: 'City b-roll' }),
    clip('laptop', 'V2', 16, 19, 'laptop.mp4', 0, { name: 'Laptop b-roll' }),
    clip('team', 'V2', 27, 30, 'team.mp4', 0, { name: 'Team b-roll' }),
    clip('title', 'T1', 0, 3, 'text', 0, { name: 'Title', text: 'Launch week' }),
    clip('caption', 'T1', 35, 39, 'text', 0, { name: 'Caption', text: 'Ship every week' }),
    clip('music', 'A1', 0, 40, 'track.mp3', 0, { name: 'Music', volume: 0.8 }),
  ];
  return {
    fps: FPS,
    tracks: [
      { id: 'T1', name: 'Titles', kind: 'text', syncLock: true },
      { id: 'V2', name: 'B-roll', kind: 'video', syncLock: true },
      { id: 'V1', name: 'Main', kind: 'video', syncLock: true },
      // Music usually keeps playing under the cut, so it does not ripple.
      { id: 'A1', name: 'Music', kind: 'audio', syncLock: false },
    ],
    clips: Object.fromEntries(clips.map((c) => [c.id, c])),
  };
}

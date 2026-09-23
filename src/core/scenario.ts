// The demo story: two editors work on the sample project at the same time.
// Each step is a real edit, so tests, the benchmark and the demo tell the same story.

import { addClip, rippleDelete, rippleTrimEnd, setProp, toggleEffect } from './ops.ts';
import { FPS } from './sample.ts';
import type { Clip, Timeline } from './timeline.ts';

const s = (seconds: number) => seconds * FPS;

function newClip(id: string, track: string, from: number, to: number, source: string, name: string): Clip {
  const props: Record<string, string> = source === 'text' ? { name, text: name } : { name };
  return { id, track, start: s(from), source, in: 0, out: s(to - from), props, effects: [] };
}

export interface Step {
  label: string;
  apply: (tl: Timeline) => Timeline;
}

export const aditiSteps: Step[] = [
  { label: 'Ripple delete "Point 2"', apply: (tl) => rippleDelete(tl, 'p2') },
  { label: 'Title text → "Ship week"', apply: (tl) => setProp(tl, 'title', 'text', 'Ship week') },
  {
    label: 'Add "Three things we learned"',
    apply: (tl) => addClip(tl, newClip('chapter', 'T1', 14, 17, 'text', 'Three things we learned')),
  },
];

export const rahulSteps: Step[] = [
  { label: 'Ripple trim "Intro" by 1s', apply: (tl) => rippleTrimEnd(tl, 'intro', s(1)) },
  { label: 'Intro grade → warm', apply: (tl) => setProp(tl, 'intro', 'grade', 'warm') },
  { label: 'Grain on "Point 3"', apply: (tl) => toggleEffect(tl, 'p3', 'grain') },
  { label: 'Laptop opacity → 0.8', apply: (tl) => setProp(tl, 'laptop', 'opacity', 0.8) },
  { label: 'Title text → "Launch week 2026"', apply: (tl) => setProp(tl, 'title', 'text', 'Launch week 2026') },
  {
    label: 'Add "Whiteboard b-roll"',
    apply: (tl) => addClip(tl, newClip('whiteboard', 'V2', 24, 26, 'whiteboard.mp4', 'Whiteboard b-roll')),
  },
  {
    label: 'Add "Built in the browser"',
    apply: (tl) => addClip(tl, newClip('built', 'T1', 25, 28, 'text', 'Built in the browser')),
  },
];

export const applySteps = (tl: Timeline, steps: Step[]) => steps.reduce((t, step) => step.apply(t), tl);

// npm run bench            → 1,000 / 5,000 / 20,000 clips
// npm run bench -- 1000    → one size
import { runBench } from '../src/bench/run.ts';

const sizes = process.argv.slice(2).map(Number).filter(Boolean);
const rows = [];
for (const n of sizes.length ? sizes : [1000, 5000, 20000]) {
  rows.push(await runBench(n));
}

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(2)} MB`;
const ms = (x: number) => `${x.toFixed(2)} ms`;
const table = [
  ['clips', 'full copies ×101', 'stored', 'smaller by', 'commit (median)', 'diff (median)', 'merge (median)'],
  ...rows.map((r) => [r.clips.toLocaleString('en'), mb(r.fullCopiesBytes), mb(r.storedBytes), `${r.ratio.toFixed(1)}×`, ms(r.commitMs), ms(r.diffMs), ms(r.mergeMs)]),
];
const widths = table[0].map((_, i) => Math.max(...table.map((row) => row[i].length)));
for (const [i, row] of table.entries()) {
  console.log(row.map((c, j) => (j === 0 ? c.padEnd(widths[j]) : c.padStart(widths[j]))).join('  '));
  if (i === 0) console.log(widths.map((w) => '-'.repeat(w)).join('  '));
}

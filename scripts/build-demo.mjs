// Builds the demo into ONE self-contained file: docs/index.html.
// (GitHub Pages can serve the docs/ folder of the main branch directly.)
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const out = await build({
  entryPoints: ['src/demo/main.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  write: false,
  legalComments: 'none',
});
// A "</script" inside the code would end the inline script tag early.
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\/script');
const css = await readFile('src/demo/style.css', 'utf8');
const html = (await readFile('src/demo/index.html', 'utf8'))
  // Functions, not strings, as replacements: "$&" in the code must stay as it is.
  .replace('/*STYLE*/', () => css)
  .replace('/*SCRIPT*/', () => js);
await mkdir('docs', { recursive: true });
await writeFile('docs/index.html', html);
console.log(`docs/index.html  ${(html.length / 1024).toFixed(1)} KB`);

// Serves the built demo on http://localhost:5173.
// Opens it the way GitHub Pages will serve it, and re-reads the file on each request so a rebuild shows on refresh.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const port = Number(process.env.PORT ?? 5173);
createServer(async (_, res) => {
  try {
    const html = await readFile('docs/index.html'); // read on every request, so a rebuild shows up on refresh
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Run "npm run build" first.');
  }
}).listen(port, () => console.log(`Demo on http://localhost:${port}  (Ctrl+C to stop)`));

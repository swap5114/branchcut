import { createApp } from './server.ts';

const port = Number(process.env.PORT ?? 8787);
const dataDir = process.env.DATA_DIR ?? 'data';

createApp({ dataDir }).listen(port, () => {
  console.log(`Branchcut API on http://localhost:${port}  (data in ./${dataDir})`);
});

// index.js
// Server entry point: compiles the app with the LLM compiler and starts Express.

import { compileApp } from './llm-compiler.js';
import chokidar from 'chokidar';

const PORT = Number(process.env.PORT) || 3000;

let server = null;

async function startServer() {
  const app = await compileApp();
  return new Promise((resolve, reject) => {
    const s = app.listen(PORT, () => {
      console.log(`[my-ai-framework] Listening on http://localhost:${PORT}`);
      resolve(s);
    });
    s.on('error', reject);
  });
}

async function stopServer() {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  server = null;
  console.log('[my-ai-framework] Server stopped.');
}

async function main() {
  try {
    server = await startServer();
  } catch (err) {
    console.error('[my-ai-framework] Failed to start server:', err?.message || err);
  }

  const watcher = chokidar.watch('app.txt', {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 150,
      pollInterval: 50,
    },
  });

  watcher.on('change', async (changedPath) => {
    console.log(`[my-ai-framework] Detected change in ${changedPath}. Recompiling and reloading...`);
    try {
      await stopServer();
      server = await startServer();
      console.log('[my-ai-framework] Reload complete.');
    } catch (err) {
      console.error('[my-ai-framework] Reload failed:', err?.message || err);
    }
  });

  watcher.on('error', (err) => {
    console.error('[my-ai-framework] File watcher error:', err?.message || err);
  });

  process.on('SIGINT', async () => {
    console.log('\n[my-ai-framework] Shutting down...');
    try {
      await watcher.close();
    } catch (_) {}
    await stopServer().catch(() => {});
    process.exit(0);
  });
}

main();

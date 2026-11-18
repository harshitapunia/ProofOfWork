/** Local asset builder and loopback-only demo preview. No backend proxy or public listener. */
import { build, context } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const development = process.argv.includes('--serve');
const serve = development || process.argv.includes('--preview');
const options = { absWorkingDir: root, entryPoints: ['src/main.tsx'], bundle: true, outdir: 'dist/assets', entryNames: 'app',
  format: 'esm', target: 'es2022', jsx: 'automatic', minify: !development,
  define: { 'process.env.NODE_ENV': JSON.stringify(development ? 'development' : 'production') }, logLevel: 'info' };
await mkdir('dist', { recursive: true });
// Public assets are explicit; never copy local config, traces or credentials.
await copyFile('public/mark.svg', 'dist/mark.svg');
const html = (await readFile('index.html', 'utf8')).replace('<script type="module" src="/src/main.tsx"></script>',
  '<link rel="stylesheet" href="/assets/app.css" /><script type="module" src="/assets/app.js"></script>');
await writeFile('dist/index.html', html);
if (!serve) await build(options);
else {
  const ctx = await context(options); await ctx.rebuild(); if (development) await ctx.watch();
  const dist = resolve('dist');
  const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('cache-control', 'no-store');
    if (!['127.0.0.1:4173', 'localhost:4173'].includes(req.headers.host ?? '') || !['GET','HEAD'].includes(req.method ?? '')) { res.writeHead(403).end(); return; }
    try {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1:4173').pathname);
      const file = resolve(dist, path === '/' ? 'index.html' : '.' + path);
      if (!file.startsWith(dist + sep)) { res.writeHead(404).end(); return; }
      const bytes = await readFile(file);
      res.setHeader('content-type', mime[extname(file)] ?? 'application/octet-stream');
      res.writeHead(200).end(req.method === 'HEAD' ? undefined : bytes);
    } catch { res.writeHead(404).end('Not found'); }
  });
  server.on('error', error => { console.error(error.message); process.exitCode = 1; void ctx.dispose(); });
  server.listen(4173, '127.0.0.1', () => console.log('ProofOfWork demo: http://127.0.0.1:4173 (reload after edits)'));
  const stop = () => { server.close(); void ctx.dispose().then(() => process.exit()); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

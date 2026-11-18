/** Local asset builder and loopback-only preview. Development never writes production output. */
import { build, context } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const development = process.argv.includes('--serve'), preview = process.argv.includes('--preview');
const port = Number(process.argv.find(a => a.startsWith('--port='))?.slice(7) ?? 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local preview port');
const output = development ? '.dev' : 'dist';
const shell = async () => (await readFile('index.html', 'utf8')).replace('<script type="module" src="/src/main.tsx"></script>',
  '<link rel="stylesheet" href="/assets/app.css" /><script type="module" src="/assets/app.js"></script>');
const options = { absWorkingDir: root, entryPoints: ['src/main.tsx'], bundle: true, outdir: output + '/assets', entryNames: 'app',
  format: 'esm', target: 'es2022', jsx: 'automatic', minify: !development,
  define: { 'process.env.NODE_ENV': JSON.stringify(development ? 'development' : 'production') }, logLevel: 'info' };
let ctx;
if (preview) {
  try { await Promise.all(['index.html', 'mark.svg', 'assets/app.js', 'assets/app.css'].map(p => access('dist/' + p))); }
  catch { throw new Error('Production output is missing. Run npm run build before npm run preview.'); }
} else if (development) {
  ctx = await context(options); await ctx.rebuild(); await ctx.watch();
} else {
  await build(options); await mkdir('dist', { recursive: true });
  await copyFile('public/mark.svg', 'dist/mark.svg'); await writeFile('dist/index.html', await shell());
}
if (development || preview) {
  const directory = resolve(output);
  const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('cache-control', 'no-store');
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? '') || !['GET','HEAD'].includes(req.method ?? '')) { res.writeHead(403).end(); return; }
    try {
      const path = decodeURIComponent(new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname);
      let bytes;
      if (development && path === '/') bytes = await shell();
      else if (development && path === '/mark.svg') bytes = await readFile('public/mark.svg');
      else {
        const file = resolve(directory, path === '/' ? 'index.html' : '.' + path);
        if (!file.startsWith(directory + sep)) { res.writeHead(404).end(); return; }
        bytes = await readFile(file);
      }
      res.setHeader('content-type', path === '/' ? mime['.html'] : mime[extname(path)] ?? 'application/octet-stream');
      res.writeHead(200).end(req.method === 'HEAD' ? undefined : bytes);
    } catch { res.writeHead(404).end('Not found'); }
  });
  server.on('error', error => { console.error(error.message); process.exitCode = 1; void ctx?.dispose(); });
  server.listen(port, '127.0.0.1', () => console.log(`ProofOfWork ${development ? 'development' : 'production preview'}: http://127.0.0.1:${port}`));
  const stop = () => { server.close(); void Promise.resolve(ctx?.dispose()).then(() => process.exit()); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

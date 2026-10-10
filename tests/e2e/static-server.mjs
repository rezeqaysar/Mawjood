// tests/e2e/static-server.mjs — dependency-free static file server for CI smoke tests.
//
// Serves a directory (the `npx expo export --platform web` output in
// apps/mobile/dist) over HTTP with an SPA fallback: any GET that doesn't
// match a file returns index.html, mirroring how the app is served on
// GitHub Pages (404.html → index.html). Plain Node stdlib only — no
// framework, no install needed beyond `node`.
//
// Usage: node tests/e2e/static-server.mjs <distDir> [port]
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const root = path.resolve(process.argv[2] ?? 'apps/mobile/dist');
const port = Number(process.argv[3] ?? 8901);

const indexBody = await fs.readFile(path.join(root, 'index.html')).catch(() => null);
if (!indexBody) {
  console.error(`static-server: no index.html found under ${root} — did the web export run?`);
  process.exit(2);
}

const safeJoin = (urlPath) => {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const joined = path.normalize(path.join(root, decoded));
  if (!joined.startsWith(root + path.sep) && joined !== root) return null; // path traversal guard
  return joined;
};

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain' });
    return res.end('method not allowed');
  }
  let file = safeJoin(req.url ?? '/');
  if (file === null) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end('bad request');
  }
  let stat = null;
  try {
    stat = await fs.stat(file);
    if (stat.isDirectory()) file = path.join(file, 'index.html');
  } catch {
    // miss → SPA fallback below
  }
  let body = indexBody; // default: SPA fallback
  if (stat?.isFile()) {
    try {
      body = await fs.readFile(file);
    } catch {
      body = indexBody;
    }
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
  res.end(req.method === 'HEAD' ? undefined : body);
});

server.listen(port, () => {
  console.log(`static-server: serving ${root} on http://localhost:${port}`);
});

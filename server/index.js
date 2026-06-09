// Tiny zero-dep HTTP server for sf-activity-tracker.
// Serves /public as static and /api/* as JSON endpoints.

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

import * as routes from './routes/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '..', 'public');
const PORT = parseInt(process.env.PORT || '7825', 10);
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    if (path.startsWith('/api/')) {
      return await handleApi(req, res, path, url);
    }
    return serveStatic(req, res, path);
  } catch (err) {
    console.error('Server error:', err);
    sendJson(res, 500, { error: err.message });
  }
});

async function handleApi(req, res, path, url) {
  const route = routes.match(req.method, path);
  if (!route) return sendJson(res, 404, { error: `No route for ${req.method} ${path}` });

  let body = null;
  if (req.method === 'POST' || req.method === 'PUT') {
    body = await parseJsonBody(req);
  }

  try {
    await route.handler({ req, res, body, url, sendJson });
  } catch (err) {
    console.error(`Route ${path} failed:`, err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message, stack: err.stack?.split('\n').slice(0, 3) });
  }
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      if (!data) return resolve(null);
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error(`Invalid JSON body: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, path) {
  let filePath = path === '/' ? '/index.html' : path;
  const fullPath = join(PUBLIC_DIR, filePath);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    return sendText(res, 403, 'Forbidden');
  }
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    return sendText(res, 404, 'Not found');
  }
  const ext = extname(fullPath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
  res.end(readFileSync(fullPath));
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendText(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`\n🗓  sf-activity-tracker running at ${url}\n`);
  // Open browser unless suppressed (uses execFile, not shell — no injection risk)
  if (process.env.SF_AT_NO_OPEN !== '1' && process.platform === 'darwin') {
    execFile('open', [url], () => {});
  }
});

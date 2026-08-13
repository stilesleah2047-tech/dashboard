'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createStore } = require('./store');
const { handle } = require('./api');
const { seedIfEmpty } = require('./seed');

loadEnv(path.join(__dirname, '..', '.env'));

const PORT = Number(process.env.PORT || 4000);
const WEB = path.resolve(__dirname, '..', '..', 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.csv': 'text/csv; charset=utf-8', '.woff2': 'font/woff2',
};

/** Minimal .env reader — avoids a dependency for four settings. */
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  }, headers || {}));
  res.end(body);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * The front-end files ship with an empty apiUrl so they also run standalone on
 * demo data. When this server hands them out, point them at its own API.
 */
function serveHtml(res, file) {
  let html = fs.readFileSync(file, 'utf8');
  html = html.replace(/apiUrl:\s*''/, "apiUrl: '/api'");
  send(res, 200, html, { 'Content-Type': MIME['.html'] });
}

function serveStatic(req, res) {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const file = path.resolve(WEB, rel);
  if (!file.startsWith(WEB)) return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  }
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html') return serveHtml(res, file);
  send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[ext] || 'application/octet-stream' });
}

function checkConfig() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16 || secret === 'change-me-to-something-long-and-random') {
    const generated = require('crypto').randomBytes(32).toString('hex');
    throw new Error(
      'SESSION_SECRET is not set.\n\n' +
      '  Create server/.env (copy server/.env.example) and put this in it:\n\n' +
      '    SESSION_SECRET=' + generated + '\n\n' +
      '  Sessions are signed with it, so the server will not start without one.');
  }
}

async function start() {
  checkConfig();
  const store = createStore();
  await store.init();
  const seeded = await seedIfEmpty(store);

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      return send(res, 204, '', {
        'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      });
    }

    if (req.url && req.url.split('?')[0] === '/api') {
      const cors = { 'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*' };
      if (req.method !== 'POST') return send(res, 405, JSON.stringify({ ok: false, error: 'Use POST.' }), cors);
      try {
        const body = await readBody(req);
        const out = await handle(store, JSON.parse(body || '{}'));
        send(res, 200, JSON.stringify(out), cors);
      } catch (err) {
        const msg = String(err && err.message || err);
        const auth = /sign in again|session expired|disabled|Administrator access|do not have access|incorrect/i.test(msg);
        if (!auth) console.error('  api error:', msg);
        send(res, auth ? 401 : 400, JSON.stringify({ ok: false, error: msg }), cors);
      }
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
    send(res, 405, JSON.stringify({ ok: false, error: 'Method not allowed.' }));
  });

  server.listen(PORT, () => {
    console.log('');
    console.log('  Digital Media Hawkers — reporting');
    console.log('  Portal   http://localhost:' + PORT + '/portal.html');
    console.log('  Admin    http://localhost:' + PORT + '/admin.html');
    if (store.kind === 'mongodb') {
      console.log('  Storage  MongoDB');
    } else if (store.kind === 'file') {
      console.log('  Storage  ' + store.path);
      console.log('           Fine for testing. Set MONGODB_URI in server/.env before real clients.');
    } else {
      console.log('  Storage  memory — nothing is saved');
    }
    if (seeded) {
      console.log('');
      console.log('  First run. Created administrator:');
      console.log('    ' + seeded.email);
      console.log('    ' + seeded.password);
      console.log('  Sign in and change that password.');
    }
    console.log('');
  });

  const shutdown = async () => {
    console.log('\n  Stopping.');
    server.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { server, store };
}

if (require.main === module) {
  start().catch(err => {
    console.error('\n  Could not start:', err.message, '\n');
    process.exit(1);
  });
}

module.exports = { start, loadEnv };

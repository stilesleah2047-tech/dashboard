'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createStore } = require('./store');
const { handle } = require('./api');
const { iso } = require('./plan');
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

  // ---- Progressive simulation: catch-up on boot, then 30-min tick ----
  // On server start, run a simulation tick to catch up any campaigns
  // whose simulated data is behind (e.g. server was down for a while).
  // Then schedule a periodic tick every 30 minutes so simulated figures
  // increment intra-day rather than waiting for midnight.
  await runSimTick(store);
  schedulePeriodicSimTick(store);

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
      const safe = String(store.uri || '').replace(/\/\/([^:/@]+):([^@]+)@/, (m, u) => '//' + u + ':••••••@');
      console.log('  Storage  MongoDB · ' + (process.env.MONGODB_DB || 'dmh_reporting'));
      console.log('           ' + safe);
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

/**
 * Run one simulation tick — advance simulated delivery for all active
 * campaigns up to today. Called on boot (catch-up) and daily at midnight.
 */
async function runSimTick(store) {
  try {
    const result = await handle(store, { action: 'admin.simTick' });
    if (result && result.campaignsAdvanced > 0) {
      console.log('  [simTick] ' + result.tick + ' — advanced ' + result.campaignsAdvanced + ' campaign(s)');
    }
  } catch (e) {
    console.error('  [simTick] error:', e.message);
  }
}

/**
 * Schedule a periodic simulation tick every 30 minutes.
 *
 * After each tick, we re-schedule for the next 30-minute boundary (aligned
 * to the clock, e.g. :00 or :30). This keeps ticks evenly spaced and
 * avoids drift. The timer is resilient to server restarts because
 * runSimTick on boot catches up any missed time.
 *
 * Each tick regenerates simulated data up to the current time, using the
 * time-of-day as a dayFraction so the current day's row gradually fills
 * in. Past days are unchanged (deterministic PRNG + upsert by compound key).
 */
function schedulePeriodicSimTick(store) {
  const INTERVAL = 30 * 60 * 1000; // 30 minutes in ms
  const now = new Date();
  // Align to next 30-min boundary on the clock (:00 or :30 UTC).
  const mins = now.getUTCMinutes();
  const secs = now.getUTCSeconds();
  const ms = now.getUTCMilliseconds();
  const elapsed = (mins % 30) * 60000 + secs * 1000 + ms;
  const delay = elapsed > 0 ? INTERVAL - elapsed : 0;

  setTimeout(async () => {
    await runSimTick(store);
    // Re-schedule for the next 30-minute boundary.
    schedulePeriodicSimTick(store);
  }, delay || INTERVAL);

  const next = new Date(now.getTime() + (delay || INTERVAL));
  const hh = String(next.getUTCHours()).padStart(2, '0');
  const mm = String(next.getUTCMinutes()).padStart(2, '0');
  console.log('  [simTick] next tick at ' + iso(next) + ' ' + hh + ':' + mm + ' UTC (in ' + Math.round((delay || INTERVAL) / 60000) + ' min)');
}

if (require.main === module) {
  start().catch(err => {
    console.error('\n  Could not start:', err.message, '\n');
    process.exit(1);
  });
}

module.exports = { start, loadEnv };

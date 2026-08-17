'use strict';

/**
 * Storage.
 *
 * Set MONGODB_URI and everything below runs against MongoDB.
 *
 * Leave it unset and the same interface runs in memory, backed by a JSON file
 * (server/data.json) so that clients, campaigns and logins survive a restart.
 * That makes `npm start` work with nothing installed while avoiding the trap
 * of creating a login, restarting, and finding it gone. Pass no path — as the
 * tests do — and it stays purely in memory.
 *
 * Collections
 *   clients    { code, name, partner, currency, budget, active, createdAt }
 *   users      { email, clientCode, name, role, passwordHash, active, lastLogin }
 *   campaigns  { campaignId, clientCode, name, billing, rate, ctr, installRate,
 *                budget, startDate, endDate, objective, shape, plan[], targets }
 *   actuals    { clientCode, campaignId, date, impressions, clicks, spend, downloads }
 *
 * `plan` rows are targets computed from the budget. `actuals` rows are
 * delivery reported by the media partner. The two never mix: nothing in this
 * file copies a plan figure into an actuals record.
 */

const lower = s => String(s || '').trim().toLowerCase();
const upper = s => String(s || '').trim().toUpperCase();

/* ── in-memory ─────────────────────────────────────────────────────────── */
function memoryStore(persistPath) {
  const fs = persistPath ? require('fs') : null;
  let db = { clients: [], users: [], campaigns: [], actuals: [] };
  const clone = v => JSON.parse(JSON.stringify(v));

  function load() {
    if (!fs || !fs.existsSync(persistPath)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
      for (const k of Object.keys(db)) if (Array.isArray(saved[k])) db[k] = saved[k];
    } catch (err) {
      console.error('  Could not read ' + persistPath + ' — starting empty. (' + err.message + ')');
    }
  }
  function save() {
    if (!fs) return;
    try {
      fs.writeFileSync(persistPath, JSON.stringify(db, null, 2));
    } catch (err) {
      console.error('  Could not write ' + persistPath + ':', err.message);
    }
  }
  // Every mutating method saves; wrapped once here rather than in twelve places.
  const w = fn => async function (...args) { const out = await fn.apply(null, args); save(); return out; };

  const api = {
    kind: persistPath ? 'file' : 'memory',
    path: persistPath || null,
    async init() { load(); },
    async close() { save(); },

    async listClients() { return clone(db.clients); },
    async findClient(code) { return clone(db.clients.find(c => c.code === upper(code)) || null); },
    upsertClient: w(async function (doc) {
      const code = upper(doc.code);
      const i = db.clients.findIndex(c => c.code === code);
      const row = Object.assign({}, doc, { code });
      if (i > -1) { row.createdAt = db.clients[i].createdAt; db.clients[i] = row; return { updated: true, code }; }
      row.createdAt = new Date().toISOString();
      db.clients.push(row);
      return { created: true, code };
    }),
    setClientActive: w(async function (code, active) {
      const c = db.clients.find(c => c.code === upper(code));
      if (!c) throw new Error('No client with code ' + upper(code) + '.');
      c.active = !!active;
    }),

    async listUsers() { return clone(db.users); },
    async findUser(email) { return clone(db.users.find(u => u.email === lower(email)) || null); },
    upsertUser: w(async function (doc) {
      const email = lower(doc.email);
      const i = db.users.findIndex(u => u.email === email);
      const row = Object.assign({}, doc, { email });
      if (i > -1) { row.lastLogin = db.users[i].lastLogin; db.users[i] = row; return { updated: true, email }; }
      db.users.push(row);
      return { created: true, email };
    }),
    setUserActive: w(async function (email, active) {
      const u = db.users.find(u => u.email === lower(email));
      if (!u) throw new Error('No login for ' + lower(email) + '.');
      u.active = !!active;
    }),
    touchLogin: w(async function (email) {
      const u = db.users.find(u => u.email === lower(email));
      if (u) u.lastLogin = new Date().toISOString();
    }),

    async listCampaigns(clientCode) {
      const all = clone(db.campaigns);
      return clientCode ? all.filter(c => c.clientCode === upper(clientCode)) : all;
    },
    async findCampaign(campaignId) {
      return clone(db.campaigns.find(c => String(c.campaignId) === String(campaignId)) || null);
    },
    upsertCampaign: w(async function (doc) {
      const id = String(doc.campaignId);
      const i = db.campaigns.findIndex(c => String(c.campaignId) === id);
      const row = Object.assign({}, doc, { campaignId: id, clientCode: upper(doc.clientCode) });
      if (i > -1) { row.createdAt = db.campaigns[i].createdAt; db.campaigns[i] = row; return { updated: true, campaignId: id }; }
      row.createdAt = new Date().toISOString();
      db.campaigns.push(row);
      return { created: true, campaignId: id };
    }),
    deleteCampaign: w(async function (campaignId) {
      const id = String(campaignId);
      db.campaigns = db.campaigns.filter(c => String(c.campaignId) !== id);
      db.actuals = db.actuals.filter(a => String(a.campaignId) !== id);
    }),

    async listActuals(clientCode) {
      return clone(db.actuals.filter(a => a.clientCode === upper(clientCode)));
    },
    upsertActuals: w(async function (rows) {
      let written = 0;
      for (const r of rows) {
        const i = db.actuals.findIndex(a =>
          String(a.campaignId) === String(r.campaignId) && a.date === r.date);
        if (i > -1) db.actuals[i] = Object.assign({}, r); else db.actuals.push(Object.assign({}, r));
        written++;
      }
      return written;
    }),
  };
  return api;
}

/* ── mongodb ───────────────────────────────────────────────────────────── */
function mongoStore(uri, dbName) {
  let MongoClient;
  try {
    MongoClient = require('mongodb').MongoClient;
  } catch (err) {
    throw new Error(
      'MONGODB_URI is set but the MongoDB driver is not installed.\n' +
      '  Run this once, inside the server folder:\n\n' +
      '    npm install mongodb\n');
  }

  // serverSelectionTimeoutMS keeps a wrong host from hanging the boot for 30s.
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: Number(process.env.MONGO_TIMEOUT_MS || 8000),
    retryWrites: true,
  });
  let db = null;
  const strip = d => { if (d) delete d._id; return d; };

  return {
    kind: 'mongodb',
    uri,
    async init() {
      try {
        await client.connect();
        await client.db(dbName || 'dmh_reporting').command({ ping: 1 });
      } catch (err) {
        throw new Error('Could not reach MongoDB.\n' + mongoHint(err, uri));
      }
      db = client.db(dbName || 'dmh_reporting');
      await db.collection('clients').createIndex({ code: 1 }, { unique: true });
      await db.collection('users').createIndex({ email: 1 }, { unique: true });
      await db.collection('campaigns').createIndex({ campaignId: 1 }, { unique: true });
      await db.collection('campaigns').createIndex({ clientCode: 1 });
      await db.collection('actuals').createIndex({ campaignId: 1, date: 1 }, { unique: true });
      await db.collection('actuals').createIndex({ clientCode: 1 });
    },
    async close() { await client.close(); },

    async listClients() { return (await db.collection('clients').find({}).toArray()).map(strip); },
    async findClient(code) { return strip(await db.collection('clients').findOne({ code: upper(code) })); },
    async upsertClient(doc) {
      const code = upper(doc.code);
      const row = Object.assign({}, doc, { code });
      delete row.createdAt;
      const res = await db.collection('clients').updateOne(
        { code },
        { $set: row, $setOnInsert: { createdAt: new Date().toISOString() } },
        { upsert: true });
      return { code, created: !!res.upsertedCount, updated: !res.upsertedCount };
    },
    async setClientActive(code, active) {
      const res = await db.collection('clients').updateOne({ code: upper(code) }, { $set: { active: !!active } });
      if (!res.matchedCount) throw new Error('No client with code ' + upper(code) + '.');
    },

    async listUsers() { return (await db.collection('users').find({}).toArray()).map(strip); },
    async findUser(email) { return strip(await db.collection('users').findOne({ email: lower(email) })); },
    async upsertUser(doc) {
      const email = lower(doc.email);
      const row = Object.assign({}, doc, { email });
      delete row.lastLogin;
      const res = await db.collection('users').updateOne(
        { email }, { $set: row, $setOnInsert: { lastLogin: '' } }, { upsert: true });
      return { email, created: !!res.upsertedCount, updated: !res.upsertedCount };
    },
    async setUserActive(email, active) {
      const res = await db.collection('users').updateOne({ email: lower(email) }, { $set: { active: !!active } });
      if (!res.matchedCount) throw new Error('No login for ' + lower(email) + '.');
    },
    async touchLogin(email) {
      await db.collection('users').updateOne({ email: lower(email) }, { $set: { lastLogin: new Date().toISOString() } });
    },

    async listCampaigns(clientCode) {
      const q = clientCode ? { clientCode: upper(clientCode) } : {};
      return (await db.collection('campaigns').find(q).toArray()).map(strip);
    },
    async findCampaign(campaignId) {
      return strip(await db.collection('campaigns').findOne({ campaignId: String(campaignId) }));
    },
    async upsertCampaign(doc) {
      const campaignId = String(doc.campaignId);
      const row = Object.assign({}, doc, { campaignId, clientCode: upper(doc.clientCode) });
      delete row.createdAt;
      const res = await db.collection('campaigns').updateOne(
        { campaignId },
        { $set: row, $setOnInsert: { createdAt: new Date().toISOString() } },
        { upsert: true });
      return { campaignId, created: !!res.upsertedCount, updated: !res.upsertedCount };
    },
    async deleteCampaign(campaignId) {
      const id = String(campaignId);
      await db.collection('campaigns').deleteOne({ campaignId: id });
      await db.collection('actuals').deleteMany({ campaignId: id });
    },

    async listActuals(clientCode) {
      return (await db.collection('actuals').find({ clientCode: upper(clientCode) }).toArray()).map(strip);
    },
    async upsertActuals(rows) {
      if (!rows.length) return 0;
      const ops = rows.map(r => ({
        updateOne: {
          filter: { campaignId: String(r.campaignId), date: r.date },
          update: { $set: r },
          upsert: true,
        },
      }));
      const res = await db.collection('actuals').bulkWrite(ops, { ordered: false });
      return (res.upsertedCount || 0) + (res.modifiedCount || 0);
    },
  };
}

/** Turn a driver error into the thing the person actually needs to change. */
function mongoHint(err, uri) {
  const m = String(err && err.message || err);
  const atlas = /mongodb\+srv/.test(String(uri));
  const lines = ['  ' + m.split('\n')[0]];
  if (/Authentication failed|bad auth/i.test(m)) {
    lines.push('', '  The host answered, so the URI is right but the username or password is not.',
      '  Check the database user in Atlas under Database Access.',
      '  A password with @ : / ? # or % in it must be percent-encoded in the URI.');
  } else if (/ENOTFOUND|getaddrinfo|querySrv/i.test(m)) {
    lines.push('', '  That hostname does not resolve. Copy the connection string again from Atlas',
      '  (Connect → Drivers), or check for a typo.');
  } else if (/ECONNREFUSED/i.test(m)) {
    lines.push('', atlas
      ? '  The connection was refused. Unusual for Atlas — check the port in the URI.'
      : '  Nothing is listening there. Is MongoDB running?\n' +
        '    macOS   brew services start mongodb-community\n' +
        '    Linux   sudo systemctl start mongod\n' +
        '    Windows net start MongoDB');
  } else if (/timed out|ServerSelectionTimeout/i.test(m)) {
    lines.push('', atlas
      ? '  Reached the network but not the cluster. Nine times out of ten this is the IP\n' +
        '  allowlist: Atlas → Network Access → Add IP Address → your server\'s address.'
      : '  Reached the host but got no answer. Is MongoDB running and listening on that port?');
  } else if (/Invalid scheme|Invalid connection string/i.test(m)) {
    lines.push('', '  The URI must start with mongodb:// or mongodb+srv://');
  }
  return lines.join('\n');
}

function createStore() {
  const uri = process.env.MONGODB_URI;
  if (uri) return mongoStore(uri, process.env.MONGODB_DB);
  const path = require('path');
  return memoryStore(process.env.DATA_FILE ||
    path.resolve(__dirname, '..', 'data.json'));
}

module.exports = { createStore, memoryStore, mongoStore, mongoHint };

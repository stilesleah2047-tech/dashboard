'use strict';

/**
 * Move everything from the local file into MongoDB.
 *
 *   node server/src/migrate.js
 *
 * For when you set the portal up on file storage, created clients, campaigns
 * and logins, and are now pointing it at a database. Safe to run twice —
 * records are upserted on their natural keys, so nothing duplicates. Reads
 * server/data.json and does not modify or delete it.
 */

const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./server');
const { createStore, memoryStore } = require('./store');

loadEnv(path.resolve(__dirname, '..', '.env'));

(async () => {
  const file = process.env.DATA_FILE || path.resolve(__dirname, '..', 'data.json');
  console.log('');

  if (!process.env.MONGODB_URI) {
    console.error('  MONGODB_URI is not set, so there is nothing to migrate into.');
    console.error('  Put your connection string in server/.env first.\n');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error('  No local data file at ' + file);
    console.error('  Nothing to migrate — just start the server.\n');
    process.exit(1);
  }

  const from = memoryStore(file);
  await from.init();
  const clients = await from.listClients();
  const users = await from.listUsers();
  const campaigns = await from.listCampaigns();
  let actuals = [];
  for (const c of clients) actuals = actuals.concat(await from.listActuals(c.code));

  console.log('  Found in ' + path.basename(file) + ':');
  console.log('    clients ' + clients.length + ' · logins ' + users.length +
              ' · campaigns ' + campaigns.length + ' · delivery ' + actuals.length + ' rows');
  console.log('');

  const to = createStore();
  try {
    await to.init();
  } catch (err) {
    console.error('  ' + String(err.message || err).replace(/\n/g, '\n  ') + '\n');
    process.exit(1);
  }

  for (const c of clients) await to.upsertClient(c);
  for (const u of users) await to.upsertUser(u);          // password hashes carry over as-is
  for (const k of campaigns) await to.upsertCampaign(k);
  if (actuals.length) await to.upsertActuals(actuals);

  const after = {
    clients: (await to.listClients()).length,
    users: (await to.listUsers()).length,
    campaigns: (await to.listCampaigns()).length,
  };
  console.log('  Now in MongoDB:');
  console.log('    clients ' + after.clients + ' · logins ' + after.users +
              ' · campaigns ' + after.campaigns);
  console.log('');
  console.log('  Everyone keeps their existing password. Restart the server and it will read');
  console.log('  from MongoDB — the banner will say so.');
  console.log('');
  console.log('  Once you have checked it, ' + path.basename(file) + ' can be deleted.');
  console.log('');

  await to.close();
  await from.close();
  process.exit(0);
})().catch(err => {
  console.error('\n  ' + String(err.message || err) + '\n');
  process.exit(1);
});

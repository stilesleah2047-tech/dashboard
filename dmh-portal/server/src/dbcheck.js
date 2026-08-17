'use strict';

/**
 * Check the MongoDB connection before relying on it.
 *
 *   node server/src/dbcheck.js
 *
 * Connects with whatever is in server/.env, pings the server, creates the
 * indexes, and reports what is already in the database. Says plainly what to
 * change when it cannot connect, rather than printing a driver stack trace.
 */

const path = require('path');
const { loadEnv } = require('./server');
const { createStore } = require('./store');

loadEnv(path.resolve(__dirname, '..', '.env'));

/** Hide the password when echoing a connection string back to the terminal. */
function safeUri(uri) {
  return String(uri).replace(/\/\/([^:/@]+):([^@]+)@/, (m, user) => `//${user}:••••••@`);
}

(async () => {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || 'dmh_reporting';

  console.log('');
  if (!uri) {
    console.log('  MONGODB_URI is not set, so the server is using a local file.');
    console.log('');
    console.log('  To connect MongoDB, put one of these in server/.env:');
    console.log('');
    console.log('    MONGODB_URI=mongodb://127.0.0.1:27017');
    console.log('    MONGODB_URI=mongodb+srv://user:password@cluster0.xxxxx.mongodb.net');
    console.log('');
    process.exit(1);
  }

  console.log('  Connecting to ' + safeUri(uri));
  console.log('  Database      ' + dbName);
  console.log('');

  const store = createStore();
  try {
    await store.init();
  } catch (err) {
    console.error('  ' + String(err.message || err).replace(/\n/g, '\n  '));
    console.error('');
    process.exit(1);
  }

  const [clients, users, campaigns] = await Promise.all([
    store.listClients(), store.listUsers(), store.listCampaigns(),
  ]);
  let actuals = 0;
  for (const c of clients) actuals += (await store.listActuals(c.code)).length;

  console.log('  Connected. Indexes are in place.');
  console.log('');
  console.log('    clients    ' + clients.length);
  console.log('    logins     ' + users.length);
  console.log('    campaigns  ' + campaigns.length);
  console.log('    delivery   ' + actuals + ' day-rows');
  console.log('');

  if (!users.length) {
    console.log('  The database is empty. Start the server and it will create the first');
    console.log('  administrator and print the password once.');
  } else {
    const admins = users.filter(u => String(u.role).toLowerCase() === 'admin' && u.active);
    console.log('  ' + admins.length + ' active administrator' + (admins.length === 1 ? '' : 's') + '.');
    if (!admins.length) {
      console.log('  No active administrator — nobody can reach the console. Re-enable one in the');
      console.log('  users collection, or clear the collection and restart to seed a fresh admin.');
    }
  }
  console.log('');

  await store.close();
  process.exit(0);
})().catch(err => {
  console.error('\n  ' + String(err.message || err) + '\n');
  process.exit(1);
});

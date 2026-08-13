'use strict';

const crypto = require('crypto');
const { hashPassword } = require('./auth');

/**
 * On an empty database, create one administrator and print the password once.
 * Nothing else is created — clients, campaigns and plans are all made from the
 * admin console, and delivery data only ever arrives from a partner import.
 */
async function seedIfEmpty(store) {
  const users = await store.listUsers();
  if (users.length) return null;

  const email = String(process.env.ADMIN_EMAIL || 'admin@digitalmediahawkers.com').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || readablePassword();

  await store.upsertUser({
    email,
    clientCode: 'ALL',
    name: 'DMH admin',
    role: 'admin',
    active: true,
    passwordHash: hashPassword(password),
    lastLogin: '',
  });

  return { email, password };
}

function readablePassword() {
  const words = ('harbour kestrel tundra marble cobalt jasper willow orbit copper meadow ' +
                 'falcon amber quarry lantern thistle').split(' ');
  const pick = () => words[crypto.randomInt(words.length)];
  return pick() + '-' + pick() + '-' + crypto.randomInt(100, 1000);
}

module.exports = { seedIfEmpty };

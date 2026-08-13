'use strict';

const crypto = require('crypto');

/**
 * Passwords and sessions.
 *
 * scrypt for hashing (Node built-in, memory-hard, no native dependency to
 * install) and an HMAC-signed token for sessions. The token names the client
 * a login may see; every request is filtered by what the token says rather
 * than by what the request asks for, which is what keeps one client out of
 * another's data.
 */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const TOKEN_HOURS = Number(process.env.SESSION_HOURS || 8);

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error('SESSION_SECRET is missing or too short — set it in .env (32+ random characters).');
  }
  return s;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${key}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, salt, key] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const test = crypto.scryptSync(String(password), salt,
      Buffer.from(key, 'hex').length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(test, Buffer.from(key, 'hex'));
  } catch (err) {
    return false;
  }
}

/** Burn comparable time on an unknown email so timing can't enumerate logins. */
function decoyHash() {
  crypto.scryptSync('decoy', 'decoy', SCRYPT.keylen, SCRYPT);
}

const b64 = s => Buffer.from(s).toString('base64url');
const unb64 = s => Buffer.from(s, 'base64url').toString('utf8');
const sign = body => crypto.createHmac('sha256', secret()).update(body).digest('base64url');

function makeToken(user) {
  const body = b64(JSON.stringify({
    e: String(user.email).toLowerCase(),
    c: String(user.clientCode),
    r: String(user.role || 'client'),
    x: Date.now() + TOKEN_HOURS * 3600 * 1000,
  }));
  return body + '.' + sign(body);
}

function readToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) throw new Error('Please sign in again.');
  const expected = sign(parts[0]);
  const a = Buffer.from(parts[1]), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Please sign in again.');
  const claims = JSON.parse(unb64(parts[0]));
  if (Date.now() > claims.x) throw new Error('Your session expired. Please sign in again.');
  return claims;
}

module.exports = { hashPassword, verifyPassword, decoyHash, makeToken, readToken };

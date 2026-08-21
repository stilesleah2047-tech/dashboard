'use strict';

const { hashPassword, verifyPassword, decoyHash, makeToken, readToken } = require('./auth');
const { deriveTargets, buildPlan, planToDate, iso, toDate, dayCount,
        dayFractionFromTime,
        BILLING, normaliseBilling, simulateDelivery, simulateDeliveryUpto } = require('./plan');

const upper = s => String(s || '').trim().toUpperCase();
const lower = s => String(s || '').trim().toLowerCase();
const num = v => { const n = Number(String(v).replace(/[, %$]/g, '')); return isFinite(n) ? n : 0; };
const BAD_LOGIN = 'Email or password is incorrect.';

/* ── guards ───────────────────────────────────────────────────────────── */
async function requireUser(store, req) {
  const claims = readToken(req.token);
  const user = await store.findUser(claims.e);
  if (!user || !user.active) throw new Error('This account is disabled. Contact your account manager.');
  return user;
}
async function requireAdmin(store, req) {
  const user = await requireUser(store, req);
  if (String(user.role).toLowerCase() !== 'admin') throw new Error('Administrator access only.');
  return user;
}
async function allowedClients(store, user) {
  const clients = (await store.listClients()).filter(c => c.active);
  const scope = upper(user.clientCode);
  if (scope === 'ALL' || String(user.role).toLowerCase() === 'admin') return clients;
  const ids = scope.split(/[,\s]+/).filter(Boolean);
  return clients.filter(c => ids.includes(upper(c.code)));
}

/* ── auth ─────────────────────────────────────────────────────────────── */
async function login(store, req) {
  const email = lower(req.email);
  const user = await store.findUser(email);
  if (!user) { decoyHash(); throw new Error(BAD_LOGIN); }
  if (!user.active) throw new Error('This account is disabled. Contact your account manager.');
  if (!verifyPassword(String(req.password || ''), user.passwordHash)) throw new Error(BAD_LOGIN);

  await store.touchLogin(email);
  const clients = await allowedClients(store, user);
  return {
    token: makeToken(user),
    email,
    name: user.name || email,
    role: lower(user.role) === 'admin' ? 'admin' : 'client',
    clients: clients.map(c => ({ id: c.code, name: c.name })),
  };
}

/* ── client dashboard payload ─────────────────────────────────────────── */
/**
 * Returns one payload per client: their campaigns, each carrying a `plan`
 * (targets derived from budget) and `rows` (delivery reported by the media
 * partner). The two arrive in separate fields and the dashboard renders them
 * in separate columns — a plan figure is never presented as delivery.
 */
async function data(store, req) {
  const user = await requireUser(store, req);
  const allowed = await allowedClients(store, user);
  const wanted = upper(req.clientId || (allowed[0] && allowed[0].code) || '');
  const client = allowed.find(c => upper(c.code) === wanted);
  if (!client) throw new Error('You do not have access to that account.');

  const campaigns = await store.listCampaigns(client.code);
  if (!campaigns.length) throw new Error('No campaigns have been set up for this account yet.');

  const actuals = await store.listActuals(client.code);
  const byCampaign = new Map();
  for (const a of actuals) {
    const k = String(a.campaignId);
    if (!byCampaign.has(k)) byCampaign.set(k, []);
    byCampaign.get(k).push(a);
  }

  // Day 0 of the shared series is the earliest date anything references.
  const stamps = [];
  for (const c of campaigns) { stamps.push(toDate(c.startDate).getTime(), toDate(c.endDate).getTime()); }
  for (const a of actuals) stamps.push(toDate(a.date).getTime());
  const today = toDate(new Date());
  stamps.push(today.getTime());

  const start = new Date(Math.min(...stamps));
  const end = new Date(Math.max(...stamps));
  const idx = d => Math.round((toDate(d) - start) / 86400000);

  return {
    startDate: iso(start),
    endDate: iso(end),
    today: iso(today),
    days: idx(end) + 1,
    fetchedAt: new Date().toISOString(),
    client: {
      id: client.code,
      name: client.name,
      partner: client.partner || 'Phoenix Ads',
      currency: client.currency || 'USD',
      budget: num(client.budget),
    },
    campaigns: campaigns.map(c => {
      const allRows = (byCampaign.get(String(c.campaignId)) || [])
        .sort((a, b) => a.date.localeCompare(b.date));
      const rows = allRows
        .map(a => [idx(a.date), num(a.impressions), num(a.clicks), num(a.spend), num(a.downloads)]);
      const hasPartnerReport = allRows.some(a => a.source === 'partner-import');
      const hasSimulated = allRows.some(a => a.source === 'simulated');
      const model = normaliseBilling(c.billing);
      return {
        id: isNaN(+c.campaignId) ? c.campaignId : +c.campaignId,
        name: c.name,
        billing: model,
        outcomeLabel: BILLING[model].label,
        rate: num(c.rate),
        objective: c.objective || '',
        start: iso(c.startDate),
        end: iso(c.endDate),
        rows,                                    // delivered, from the partner
        plan: (c.plan || []).map(p => [idx(p.date), p.impressions, p.clicks, p.spend, p.downloads]),
        targets: c.targets || null,              // whole-flight targets
        planToDate: planToDate(c.plan || [], today),
        hasActuals: rows.length > 0,
        hasPartnerReport,
        hasSimulated,
      };
    }),
  };
}

/* ── admin: clients ───────────────────────────────────────────────────── */
async function listClients(store, req) {
  await requireAdmin(store, req);
  const clients = await store.listClients();
  const campaigns = await store.listCampaigns();
  return {
    clients: clients.map(c => ({
      id: c.code, name: c.name, partner: c.partner || '', currency: c.currency || 'USD',
      budget: num(c.budget), active: !!c.active, created: (c.createdAt || '').slice(0, 10),
      campaigns: campaigns.filter(k => upper(k.clientCode) === upper(c.code)).length,
    })),
  };
}

async function saveClient(store, req) {
  await requireAdmin(store, req);
  const code = upper(req.id);
  if (!/^[A-Z0-9_-]{2,16}$/.test(code)) {
    throw new Error('Client code must be 2-16 characters: letters, numbers, dash or underscore.');
  }
  if (!String(req.name || '').trim()) throw new Error('Client name is required.');
  const res = await store.upsertClient({
    code,
    name: String(req.name).trim(),
    partner: String(req.partner || 'Phoenix Ads').trim(),
    currency: upper(req.currency || 'USD'),
    budget: num(req.budget),
    active: req.active !== false,
  });
  return res;
}

async function setClientActive(store, req) {
  await requireAdmin(store, req);
  await store.setClientActive(req.id, req.active !== false);
  return {};
}

/* ── admin: users ─────────────────────────────────────────────────────── */
async function listUsers(store, req) {
  await requireAdmin(store, req);
  const users = await store.listUsers();
  return {
    users: users.map(u => ({           // the hash never leaves the database
      email: u.email, clientId: u.clientCode, name: u.name || '',
      role: lower(u.role) === 'admin' ? 'admin' : 'client',
      active: !!u.active, lastLogin: u.lastLogin || '',
    })),
  };
}

async function saveUser(store, req) {
  const me = await requireAdmin(store, req);
  const email = lower(req.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address.');
  const clientCode = upper(req.clientId);
  if (!clientCode) throw new Error('Assign the login to a client (or ALL for DMH staff).');
  const role = lower(req.role) === 'admin' ? 'admin' : 'client';

  const existing = await store.findUser(email);
  const password = String(req.password || '');
  if (!existing && password.length < 8) throw new Error('Set a password of at least 8 characters for a new login.');
  if (password && password.length < 8) throw new Error('Passwords must be at least 8 characters.');

  const active = req.active !== false;
  if (existing && email === lower(me.email) && (!active || role !== 'admin')) {
    throw new Error('You cannot remove your own administrator access.');
  }

  const res = await store.upsertUser({
    email, clientCode, name: String(req.name || '').trim(), role, active,
    passwordHash: password ? hashPassword(password) : existing.passwordHash,
  });
  return Object.assign(res, { passwordChanged: !!password });
}

async function setUserActive(store, req) {
  const me = await requireAdmin(store, req);
  if (lower(req.email) === lower(me.email) && req.active === false) {
    throw new Error('You cannot disable your own login.');
  }
  await store.setUserActive(req.email, req.active !== false);
  return {};
}

/* ── admin: campaigns and plans ───────────────────────────────────────── */
/** Live calculator for the creation form — computes targets without saving. */
async function previewPlan(store, req) {
  await requireAdmin(store, req);
  const targets = deriveTargets({
    budget: num(req.budget), billing: normaliseBilling(req.billing),
    rate: num(req.rate), ctr: num(req.ctr),
    convRate: num(req.convRate != null && req.convRate !== '' ? req.convRate : req.installRate),
  });
  const out = { targets };
  if (req.startDate && req.endDate) {
    const plan = buildPlan({
      budget: num(req.budget), billing: normaliseBilling(req.billing), rate: num(req.rate),
      ctr: num(req.ctr),
      convRate: num(req.convRate != null && req.convRate !== '' ? req.convRate : req.installRate),
      startDate: req.startDate, endDate: req.endDate, shape: req.shape,
    });
    out.days = plan.days;
    out.perDay = plan.rows[0] || null;
    out.rows = plan.rows;
  }
  return out;
}

async function listCampaigns(store, req) {
  await requireAdmin(store, req);
  const campaigns = await store.listCampaigns(req.clientId ? upper(req.clientId) : null);
  const out = [];
  for (const c of campaigns) {
    const actuals = await store.listActuals(c.clientCode);
    const mine = actuals.filter(a => String(a.campaignId) === String(c.campaignId));
    out.push({
      campaignId: c.campaignId, clientId: c.clientCode, name: c.name,
      billing: normaliseBilling(c.billing), rate: c.rate, ctr: c.ctr,
      convRate: c.convRate != null ? c.convRate : (c.installRate || 0),
      outcomeLabel: BILLING[normaliseBilling(c.billing)].label,
      budget: c.budget, startDate: c.startDate, endDate: c.endDate,
      objective: c.objective || '', shape: c.shape || 'even',
      targets: c.targets || null, planDays: (c.plan || []).length,
      actualDays: mine.length,
      hasPartnerImport: mine.some(a => a.source === 'partner-import'),
    });
  }
  return { campaigns: out };
}

async function saveCampaign(store, req) {
  await requireAdmin(store, req);
  const clientCode = upper(req.clientId);
  const client = await store.findClient(clientCode);
  if (!client) throw new Error('Pick a client for this campaign.');
  const campaignId = String(req.campaignId || '').trim();
  if (!campaignId) throw new Error('Enter the campaign ID from the media partner.');
  if (!String(req.name || '').trim()) throw new Error('Campaign name is required.');

  const existing = await store.findCampaign(campaignId);
  if (existing && upper(existing.clientCode) !== clientCode) {
    throw new Error('Campaign ID ' + campaignId + ' already belongs to ' + existing.clientCode + '.');
  }

  const billing = normaliseBilling(req.billing);
  const convRate = num(req.convRate != null && req.convRate !== '' ? req.convRate : req.installRate);
  const plan = buildPlan({
    budget: num(req.budget), billing, rate: num(req.rate), ctr: num(req.ctr),
    convRate, startDate: req.startDate, endDate: req.endDate, shape: req.shape,
  });

  const res = await store.upsertCampaign({
    campaignId, clientCode, name: String(req.name).trim(), billing,
    rate: num(req.rate), ctr: num(req.ctr), convRate,
    budget: num(req.budget), startDate: iso(req.startDate), endDate: iso(req.endDate),
    objective: String(req.objective || '').trim(), shape: plan.shape,
    targets: plan.targets, plan: plan.rows,
  });

  // Auto-generate simulated delivery data up to now (inclusive of today,
  // scaled by the current time-of-day fraction).
  // Remove any previous simulated actuals first (e.g. flight dates changed),
  // then generate fresh ones from the plan. The simulation now ticks up
  // every 30 minutes — days from campaign start through today are generated,
  // with today's row scaled by the dayFraction so figures feel "live".
  // A periodic scheduler (simTick) updates the current day's row every
  // 30 minutes. Real partner-import data on the same date will overwrite
  // simulated rows.
  const now = new Date();
  const today = iso(now);
  const frac = dayFractionFromTime(now);
  await store.deleteActualsByCampaignAndSource(campaignId, 'simulated');
  const simRows = simulateDeliveryUpto(plan, { clientCode, campaignId }, today, frac);
  if (simRows.length) await store.upsertActuals(simRows);

  return Object.assign(res, { targets: plan.targets, days: plan.days });
}

async function deleteCampaign(store, req) {
  await requireAdmin(store, req);
  await store.deleteCampaign(req.campaignId);
  return {};
}

/**
 * Sim tick — advance simulated delivery for all active campaigns.
 *
 * Called every 30 minutes by the periodic scheduler (server.js) and also
 * available as an API action for manual trigger. For each campaign that is
 * currently in-flight (startDate ≤ today ≤ endDate), this regenerates
 * simulated actuals up to the current moment, using the current time-of-day
 * as a fraction to produce intra-day granularity.
 *
 * The key insight: simulateDeliveryUpto(plan, meta, today, dayFraction)
 * always produces the same values for any FULL day because the PRNG is
 * deterministic. For the current day, the dayFraction parameter scales
 * the last day's row — so a 14:00 UTC tick shows ~58% of the day's
 * simulated values. Re-generating simply upserts the same rows (compound
 * key = campaignId+date), so past days are unchanged and only the current
 * day's row is updated with the incremental fraction.
 */
async function simTick(store, req) {
  // Optional admin guard — if a token is present, verify it.
  if (req && req.token) await requireAdmin(store, req);

  const now = new Date();
  const today = iso(now);
  const frac = dayFractionFromTime(now);
  const campaigns = await store.listCampaigns();
  let advanced = 0;

  for (const c of campaigns) {
    // Only process campaigns currently in flight.
    if (c.startDate > today || c.endDate < today) continue;

    // Skip campaigns that already have partner-reported data for today —
    // real data always takes precedence.
    const actuals = await store.listActuals(c.clientCode);
    const mine = actuals.filter(a => String(a.campaignId) === String(c.campaignId));
    const todayPartner = mine.some(a => a.date === today && a.source === 'partner-import');
    if (todayPartner) continue;

    // Rebuild the plan from campaign parameters.
    const convRate = c.convRate != null ? c.convRate : (c.installRate || 0);
    const plan = buildPlan({
      budget: num(c.budget), billing: normaliseBilling(c.billing),
      rate: num(c.rate), ctr: num(c.ctr), convRate: num(convRate),
      startDate: c.startDate, endDate: c.endDate, shape: c.shape,
    });

    // Generate simulated data up to now. The dayFraction parameter scales
    // today's row so simulated figures tick up intra-day. Past days' rows
    // are unchanged because the PRNG is deterministic and dayFraction=1
    // for them. Upsert with the compound key means no duplication.
    const simRows = simulateDeliveryUpto(plan, { clientCode: c.clientCode, campaignId: c.campaignId }, today, frac);
    if (simRows.length) {
      await store.upsertActuals(simRows);
      advanced++;
    }
  }

  return { tick: today, dayFraction: Math.round(frac * 10000) / 10000, campaignsAdvanced: advanced };
}

/**
 * Import delivery reported by the media partner. This is the only path by
 * which partner-reported actuals rows are created.
 */
async function importActuals(store, req) {
  await requireAdmin(store, req);
  const rows = Array.isArray(req.rows) ? req.rows : [];
  if (!rows.length) throw new Error('No rows to import.');

  const campaigns = await store.listCampaigns();
  const byId = new Map(campaigns.map(c => [String(c.campaignId), c]));

  const clean = [], skipped = [];
  for (const r of rows) {
    const c = byId.get(String(r.campaignId).trim());
    if (!c) { skipped.push(r.campaignId); continue; }
    let date;
    try { date = iso(r.date); } catch (err) { skipped.push(r.campaignId + ' @ ' + r.date); continue; }
    clean.push({
      clientCode: upper(c.clientCode), campaignId: String(c.campaignId), date,
      impressions: Math.max(0, Math.round(num(r.impressions))),
      clicks: Math.max(0, Math.round(num(r.clicks))),
      spend: Math.max(0, Math.round(num(r.spend) * 10000) / 10000),
      downloads: Math.max(0, Math.round(num(r.downloads))),
      source: String(r.source || 'partner-import'),
      importedAt: new Date().toISOString(),
    });
  }
  const written = await store.upsertActuals(clean);
  return { written, skipped: skipped.length, skippedIds: skipped.slice(0, 10) };
}

/* ── router ───────────────────────────────────────────────────────────── */
const ROUTES = {
  'login': login,
  'data': data,
  'admin.clients': listClients,
  'admin.saveClient': saveClient,
  'admin.clientActive': setClientActive,
  'admin.users': listUsers,
  'admin.saveUser': saveUser,
  'admin.userActive': setUserActive,
  'admin.campaigns': listCampaigns,
  'admin.saveCampaign': saveCampaign,
  'admin.deleteCampaign': deleteCampaign,
  'admin.previewPlan': previewPlan,
  'admin.importActuals': importActuals,
  'admin.simTick': simTick,
  'simTick': simTick,
  'ping': async () => ({ service: 'DMH reporting', time: new Date().toISOString() }),
};

async function handle(store, req) {
  const fn = ROUTES[String(req && req.action || '')];
  if (!fn) throw new Error('Unknown action.');
  const out = await fn(store, req || {});
  return Object.assign({ ok: true }, out);
}

module.exports = { handle, ROUTES };

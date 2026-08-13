'use strict';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-that-is-long-enough-32chars';
process.env.ADMIN_EMAIL = 'admin@digitalmediahawkers.com';
process.env.ADMIN_PASSWORD = 'admin-test-pass';

const { memoryStore } = require('../src/store');
const { handle } = require('../src/api');
const { seedIfEmpty } = require('../src/seed');
const plan = require('../src/plan');

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra ? ' — ' + extra : ''));
};
async function throws(label, fn, match) {
  try { await fn(); ok(label, false, 'no error raised'); }
  catch (err) { ok(label, match ? match.test(err.message) : true, err.message); }
}

(async () => {
  const store = memoryStore();
  await store.init();
  const seeded = await seedIfEmpty(store);
  ok('first run creates one administrator', seeded && seeded.email === 'admin@digitalmediahawkers.com');

  const call = (action, body) => handle(store, Object.assign({ action }, body));

  /* ── the calculator ────────────────────────────────────────────────── */
  {
    const t = plan.deriveTargets({ budget: 42000, billing: 'cpm', rate: 1.5, ctr: 0.0336 });
    ok('budget over CPM gives impressions', t.impressions === 28000000, t.impressions.toLocaleString());
    ok('CTR gives clicks', t.clicks === 940800, t.clicks.toLocaleString());
    ok('CPM identity holds: CPC x CTR x 1000 = rate',
      Math.abs(t.cpc * 0.0336 * 1000 - 1.5) < 1e-9, 'CPC $' + t.cpc.toFixed(4));

    const p = plan.buildPlan({ budget: 42000, billing: 'cpm', rate: 1.5, ctr: 0.0336,
      startDate: '2026-08-01', endDate: '2026-08-31', shape: 'weekday' });
    const sum = p.rows.reduce((a, r) => ({
      spend: a.spend + r.spend, impressions: a.impressions + r.impressions, clicks: a.clicks + r.clicks }),
      { spend: 0, impressions: 0, clicks: 0 });
    ok('daily spend sums exactly to budget', Math.round(sum.spend * 100) / 100 === 42000, '$' + sum.spend);
    ok('daily impressions sum exactly to target', sum.impressions === t.impressions);
    ok('daily clicks sum exactly to target', sum.clicks === t.clicks);
    ok('weekday shape dials weekends back',
      p.rows[0].spend < p.rows[2].spend, `Sat $${p.rows[0].spend} vs Mon $${p.rows[2].spend}`);
    ok('the plan is deterministic',
      JSON.stringify(plan.buildPlan({ budget: 42000, billing: 'cpm', rate: 1.5, ctr: 0.0336,
        startDate: '2026-08-01', endDate: '2026-08-31', shape: 'weekday' }).rows) === JSON.stringify(p.rows));

    await throws('a CTR over 100% is rejected',
      async () => plan.deriveTargets({ budget: 1000, billing: 'cpm', rate: 1.5, ctr: 1.4 }), /between 0 and 100/);
    await throws('a backwards flight is rejected',
      async () => plan.buildPlan({ budget: 1000, billing: 'cpm', rate: 1.5, ctr: 0.03,
        startDate: '2026-08-31', endDate: '2026-08-01' }), /before the start/);
  }

  /* ── auth ──────────────────────────────────────────────────────────── */
  await throws('a wrong password is refused',
    () => call('login', { email: seeded.email, password: 'nope' }), /incorrect/);
  await throws('an unknown email is refused with the same message',
    () => call('login', { email: 'nobody@example.com', password: 'nope' }), /incorrect/);

  const admin = await call('login', { email: seeded.email, password: seeded.password });
  ok('the administrator can sign in', admin.ok && admin.role === 'admin');
  const A = { token: admin.token };

  await throws('an unsigned token is refused',
    () => call('admin.clients', { token: 'made.up' }), /sign in again/);

  /* ── clients ───────────────────────────────────────────────────────── */
  await throws('a bad client code is rejected',
    () => call('admin.saveClient', Object.assign({ id: 'x', name: 'Nope' }, A)), /2-16 characters/);

  await call('admin.saveClient', Object.assign({ id: 'KCB', name: 'KCB Group', budget: 42000 }, A));
  await call('admin.saveClient', Object.assign({ id: 'SAF', name: 'Safaricom PLC', budget: 68000 }, A));
  const clients = await call('admin.clients', A);
  ok('both clients are stored', clients.clients.length === 2);

  /* ── campaigns and plans ───────────────────────────────────────────── */
  const saved = await call('admin.saveCampaign', Object.assign({
    clientId: 'KCB', campaignId: '41040', name: 'KCB_MBP_Campaign_Common_Cents_2026',
    billing: 'cpm', rate: 1.5, ctr: 0.0336, budget: 42000,
    startDate: '2026-08-01', endDate: '2026-08-31', shape: 'weekday', objective: 'traffic',
  }, A));
  ok('creating a campaign generates its plan', saved.days === 31 && saved.targets.impressions === 28000000);

  {
    const cpcSaved = await call('admin.saveCampaign', Object.assign({
      clientId: 'KCB', campaignId: '41055', name: 'KCB_Clicks_Buy_2026',
      billing: 'cpc', rate: 0.05, ctr: 0.03, budget: 5000,
      startDate: '2026-08-01', endDate: '2026-08-15',
    }, A));
    ok('a CPC campaign saves and plans', cpcSaved.targets.clicks === 100000,
      cpcSaved.targets.clicks.toLocaleString() + ' clicks');
    await call('admin.deleteCampaign', Object.assign({ campaignId: '41055' }, A));
  }

  await call('admin.saveCampaign', Object.assign({
    clientId: 'SAF', campaignId: '39210', name: 'PHX_SAF_Business_Positioning_2026',
    billing: 'cpd', rate: 0.42, ctr: 0.041, installRate: 0.1, budget: 10000,
    startDate: '2026-08-01', endDate: '2026-08-20',
  }, A));

  /* ── the other three buying models ────────────────────────────────── */
  {
    const cpc = plan.deriveTargets({ budget: 42000, billing: 'cpc', rate: 0.0447, ctr: 0.0336 });
    ok('a CPC buy takes clicks straight from the budget', cpc.clicks === Math.round(42000 / 0.0447),
      cpc.clicks.toLocaleString());
    // clicks are rounded before impressions are inferred, so allow a rounding gap
    ok('a CPC buy infers impressions back up from CTR',
      Math.abs(cpc.impressions - cpc.clicks / 0.0336) < 40, cpc.impressions.toLocaleString());
    ok('a CPC buy at the matching rate returns a $1.50 CPM',
      Math.abs(cpc.cpm - 1.5) < 0.01, '$' + cpc.cpm.toFixed(4));

    const cpi = plan.deriveTargets({ budget: 10000, billing: 'cpi', rate: 0.42, ctr: 0.041, convRate: 0.1 });
    ok('a CPI buy takes installs straight from the budget', cpi.conversions === Math.round(10000 / 0.42),
      cpi.conversions.toLocaleString());
    ok('a CPI buy counts installs as the result', cpi.results === cpi.conversions);
    ok('a CPI buy is labelled installs', cpi.outcomeLabel === 'Installs');

    const cpd = plan.deriveTargets({ budget: 10000, billing: 'cpd', rate: 0.42, ctr: 0.041, convRate: 0.1 });
    ok('CPD is the same arithmetic under a different name',
      cpd.conversions === cpi.conversions && cpd.outcomeLabel === 'Downloads');

    ok('a CPM buy still counts clicks as the result',
      plan.deriveTargets({ budget: 42000, billing: 'cpm', rate: 1.5, ctr: 0.0336 }).outcomeLabel === 'Clicks');

    await throws('a CPI buy without an install rate is rejected',
      async () => plan.deriveTargets({ budget: 1000, billing: 'cpi', rate: 0.5, ctr: 0.03 }),
      /rate must be between/);

    const p2 = plan.buildPlan({ budget: 10000, billing: 'cpi', rate: 0.42, ctr: 0.041,
      convRate: 0.1, startDate: '2026-08-01', endDate: '2026-08-20' });
    ok('a CPI plan spreads installs to sum exactly',
      p2.rows.reduce((a, r) => a + r.downloads, 0) === p2.targets.conversions);
    ok('the old installRate field still works',
      plan.deriveTargets({ budget: 10000, billing: 'cpd', rate: 0.42, ctr: 0.041, installRate: 0.1 })
        .conversions === cpi.conversions);
  }

  await throws('a campaign ID cannot be stolen by another client',
    () => call('admin.saveCampaign', Object.assign({
      clientId: 'SAF', campaignId: '41040', name: 'Hijack', billing: 'cpm',
      rate: 1.5, ctr: 0.03, budget: 100, startDate: '2026-08-01', endDate: '2026-08-05' }, A)),
    /already belongs to KCB/);

  const preview = await call('admin.previewPlan', Object.assign({
    budget: 20000, billing: 'cpm', rate: 1.5, ctr: 0.02,
    startDate: '2026-09-01', endDate: '2026-09-30' }, A));
  ok('the form calculator previews without saving', preview.targets.impressions === 13333333, String(preview.targets.impressions));
  ok('previewing does not create a campaign', (await call('admin.campaigns', A)).campaigns.length === 2);

  /* ── logins and isolation ──────────────────────────────────────────── */
  await call('admin.saveUser', Object.assign({
    email: 'sarah@kcb.co.ke', name: 'Sarah W.', clientId: 'KCB', password: 'kcb-test-pass' }, A));
  await call('admin.saveUser', Object.assign({
    email: 'mike@safaricom.co.ke', name: 'Mike O.', clientId: 'SAF', password: 'saf-test-pass' }, A));

  await throws('a short password is rejected',
    () => call('admin.saveUser', Object.assign({
      email: 'x@y.co.ke', clientId: 'KCB', password: 'short' }, A)), /8 characters/);

  const sarah = await call('login', { email: 'sarah@kcb.co.ke', password: 'kcb-test-pass' });
  const mike = await call('login', { email: 'mike@safaricom.co.ke', password: 'saf-test-pass' });
  ok('a client login sees only its own account', sarah.clients.length === 1 && sarah.clients[0].id === 'KCB');

  const kcbData = await call('data', { token: sarah.token, clientId: 'KCB' });
  ok('the KCB payload holds only KCB campaigns',
    kcbData.campaigns.length === 1 && kcbData.campaigns[0].id === 41040);

  await throws("a client cannot request another client's data",
    () => call('data', { token: sarah.token, clientId: 'SAF' }), /do not have access/);
  await throws('a client cannot reach the admin API',
    () => call('admin.clients', { token: sarah.token }), /Administrator access only/);
  await throws('a client cannot create campaigns',
    () => call('admin.saveCampaign', { token: sarah.token, clientId: 'KCB', campaignId: '1' }),
    /Administrator access only/);

  const safData = await call('data', { token: mike.token, clientId: 'SAF' });
  ok('the Safaricom payload holds only Safaricom campaigns',
    safData.campaigns.length === 1 && safData.campaigns[0].id === 39210);

  /* ── projection vs delivery ────────────────────────────────────────── */
  {
    const c = kcbData.campaigns[0];
    ok('the payload carries a projected series', c.plan.length === 31);
    ok('the payload starts with no delivery', c.rows.length === 0 && c.hasActuals === false);
    ok('projection and delivery are separate fields', Array.isArray(c.plan) && Array.isArray(c.rows));
    ok('whole-flight targets travel with the campaign', c.targets.impressions === 28000000);
    ok('projected-to-date is computed for pacing', c.planToDate.days >= 0);
  }

  /* ── partner delivery import ───────────────────────────────────────── */
  {
    const res = await call('admin.importActuals', Object.assign({ rows: [
      { campaignId: '41040', date: '2026-08-01', impressions: 640000, clicks: 21100, spend: 960, downloads: 0 },
      { campaignId: '41040', date: '2026-08-02', impressions: 655000, clicks: 22400, spend: 982.5, downloads: 0 },
      { campaignId: '99999', date: '2026-08-02', impressions: 1, clicks: 1, spend: 1, downloads: 0 },
    ] }, A));
    ok('partner delivery imports', res.written === 2, res.written + ' written');
    ok('rows for unknown campaigns are skipped', res.skipped === 1);

    const after = await call('data', { token: sarah.token, clientId: 'KCB' });
    const c = after.campaigns[0];
    ok('delivery lands in the delivered series', c.rows.length === 2 && c.hasActuals === true);
    ok('importing does not touch the projection', c.plan.length === 31);
    ok('delivered impressions are the imported ones, not the projected ones',
      c.rows[0][1] === 640000 && c.plan[0][1] !== 640000,
      'delivered ' + c.rows[0][1].toLocaleString() + ' vs projected ' + c.plan[0][1].toLocaleString());

    const again = await call('admin.importActuals', Object.assign({ rows: [
      { campaignId: '41040', date: '2026-08-01', impressions: 641000, clicks: 21150, spend: 961.5, downloads: 0 },
    ] }, A));
    const third = await call('data', { token: sarah.token, clientId: 'KCB' });
    ok('re-importing a day corrects it rather than duplicating',
      third.campaigns[0].rows.length === 2 && third.campaigns[0].rows[0][1] === 641000);
  }

  /* ── disabling ─────────────────────────────────────────────────────── */
  await call('admin.userActive', Object.assign({ email: 'sarah@kcb.co.ke', active: false }, A));
  await throws('a disabled login stops working immediately',
    () => call('data', { token: sarah.token, clientId: 'KCB' }), /disabled/);
  await throws('an administrator cannot disable themselves',
    () => call('admin.userActive', Object.assign({ email: seeded.email, active: false }, A)),
    /cannot disable your own/);

  await call('admin.clientActive', Object.assign({ id: 'SAF', active: false }, A));
  await throws('pausing a client blocks its logins',
    () => call('data', { token: mike.token, clientId: 'SAF' }), /do not have access/);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });

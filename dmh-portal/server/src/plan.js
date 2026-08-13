'use strict';

/**
 * The media plan calculator.
 *
 * Everything here produces a TARGET — what a campaign is expected to deliver
 * for a given budget at a given rate. Targets are stored and displayed
 * separately from actual delivery, which only ever comes from the media
 * partner's own reporting. Nothing in this file writes to an actuals record.
 *
 * Four buying models, differing in what the budget buys directly:
 *
 *   cpm   pay per thousand impressions   → impressions = budget / rate × 1000
 *   cpc   pay per click                  → clicks      = budget / rate
 *   cpi   pay per install                → conversions = budget / rate
 *   cpd   pay per download               → conversions = budget / rate
 *
 * Everything else is inferred back up the funnel from the expected rates:
 * clicks from impressions via CTR, conversions from clicks via the conversion
 * rate — or downward, for the models that buy the bottom of the funnel.
 *
 * cpi and cpd are the same arithmetic; they differ only in what the outcome is
 * called, which matters because the client's report has to use their word.
 *
 * The identity underneath all of it:
 *
 *     CPM = CPC × CTR × 1000
 *
 * so the numbers are not independent. Whichever rate is contracted, the others
 * follow from it and your expected rates rather than being picked separately.
 */

/** Which figure the budget buys directly, and what an outcome is called. */
const BILLING = {
  cpm: {buys: 'impressions', outcome: 'clicks',      label: 'Clicks',    rateLabel: 'CPM rate'},
  cpc: {buys: 'clicks',      outcome: 'clicks',      label: 'Clicks',    rateLabel: 'CPC rate'},
  cpi: {buys: 'conversions', outcome: 'conversions', label: 'Installs',  rateLabel: 'CPI rate'},
  cpd: {buys: 'conversions', outcome: 'conversions', label: 'Downloads', rateLabel: 'CPD rate'},
};
const normaliseBilling = b => (BILLING[String(b || 'cpm').toLowerCase()] ? String(b).toLowerCase() : 'cpm');

const DAY = 86400000;

function toDate(v) {
  const d = v instanceof Date ? new Date(v.getTime()) : new Date(String(v) + 'T00:00:00Z');
  if (isNaN(d.getTime())) throw new Error('Invalid date: ' + v);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
const iso = d => toDate(d).toISOString().slice(0, 10);
const dayCount = (start, end) => Math.round((toDate(end) - toDate(start)) / DAY) + 1;

/**
 * Headline targets for a whole flight.
 *
 * cpm buys:  budget buys impressions at `rate` per thousand; clicks follow
 *            from the expected CTR.
 * cpd buys:  budget buys installs at `rate` each; clicks are inferred from the
 *            expected install rate, and impressions from the expected CTR.
 */
function deriveTargets({ budget, billing, rate, ctr, convRate, installRate }) {
  budget = Number(budget);
  rate = Number(rate);
  ctr = Number(ctr);                                   // fraction: 0.0336 = 3.36%
  const model = normaliseBilling(billing);
  // installRate is the old name for the same thing, kept so existing
  // campaigns keep working.
  const conv = Number(convRate != null && convRate !== '' ? convRate : (installRate || 0));

  if (!(budget > 0)) throw new Error('Budget must be greater than zero.');
  if (!(rate > 0)) throw new Error('Rate must be greater than zero.');
  if (!(ctr > 0 && ctr < 1)) throw new Error('Expected CTR must be between 0 and 100%.');

  const needsConv = BILLING[model].buys === 'conversions';
  if (needsConv && !(conv > 0 && conv <= 1)) {
    throw new Error('Expected ' + BILLING[model].label.toLowerCase().replace(/s$/, '') +
      ' rate must be between 0 and 100% of clicks.');
  }

  let impressions, clicks, conversions;
  if (model === 'cpm') {
    impressions = budget / rate * 1000;
    clicks = impressions * ctr;
    conversions = conv > 0 ? clicks * conv : 0;
  } else if (model === 'cpc') {
    clicks = budget / rate;
    impressions = clicks / ctr;
    conversions = conv > 0 ? clicks * conv : 0;
  } else {
    conversions = budget / rate;
    clicks = conversions / conv;
    impressions = clicks / ctr;
  }

  const out = {
    impressions: Math.round(impressions),
    clicks: Math.round(clicks),
    conversions: Math.round(conversions),
    cpm: impressions ? budget / impressions * 1000 : 0,
    cpc: clicks ? budget / clicks : 0,
    cpa: conversions ? budget / conversions : 0,
    results: Math.round(BILLING[model].outcome === 'conversions' ? conversions : clicks),
    outcomeLabel: BILLING[model].label,
  };
  out.downloads = out.conversions;   // wire-compatible with existing records
  out.cpd = model === 'cpd' ? out.cpa : 0;
  return out;
}

/** Split an integer total across n weighted buckets so the parts sum exactly. */
function splitExact(total, weights) {
  const n = weights.length;
  if (!n) return [];
  const sum = weights.reduce((a, b) => a + b, 0) || n;
  const raw = weights.map(w => total * w / sum);
  const out = raw.map(Math.floor);
  let rem = Math.round(total - out.reduce((a, b) => a + b, 0));
  const order = raw.map((v, i) => [v - out[i], i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < rem; k++) out[order[k % n][1]] += 1;
  return out;
}

/** Same, for money — two decimal places, summing exactly to `total`. */
function splitMoney(total, weights) {
  const cents = splitExact(Math.round(total * 100), weights);
  return cents.map(c => c / 100);
}

/**
 * Pacing shapes. A plan is deterministic — no randomness — so the same inputs
 * always produce the same curve and it can be recomputed at any time.
 *
 *   even         flat daily budget
 *   weekday      weekends dialled back to 70%, the usual banking pattern
 *   frontloaded  heavier at launch, tapering to 60% by the end
 *   backloaded   builds toward a deadline
 */
const SHAPES = {
  even: () => 1,
  weekday: (i, n, date) => ([0, 6].includes(date.getUTCDay()) ? 0.7 : 1),
  frontloaded: (i, n) => (n < 2 ? 1 : 1.4 - 0.8 * (i / (n - 1))),
  backloaded: (i, n) => (n < 2 ? 1 : 0.6 + 0.8 * (i / (n - 1))),
};

/**
 * Build the day-by-day plan for a flight. Returns one row per day whose
 * spend, impressions, clicks and downloads sum exactly to the flight targets.
 */
function buildPlan({ budget, billing, rate, ctr, convRate, installRate, startDate, endDate, shape }) {
  const start = toDate(startDate), end = toDate(endDate);
  if (end < start) throw new Error('End date falls before the start date.');

  const n = dayCount(start, end);
  if (n > 400) throw new Error('A flight longer than 400 days is probably a typo.');

  const targets = deriveTargets({ budget, billing, rate, ctr, convRate, installRate });
  const shapeFn = SHAPES[shape] || SHAPES.even;

  const dates = [];
  for (let i = 0; i < n; i++) dates.push(new Date(start.getTime() + i * DAY));
  const weights = dates.map((d, i) => shapeFn(i, n, d));

  const spend = splitMoney(Number(budget), weights);
  const impressions = splitExact(targets.impressions, weights);
  const clicks = splitExact(targets.clicks, weights);
  const downloads = splitExact(targets.conversions, weights);

  return {
    targets,
    shape: shape || 'even',
    days: n,
    rows: dates.map((d, i) => ({
      date: iso(d),
      spend: spend[i],
      impressions: impressions[i],
      clicks: clicks[i],
      downloads: downloads[i],
    })),
  };
}

/** Planned totals from the start of the flight through `asOf`, for pacing. */
function planToDate(rows, asOf) {
  const cut = iso(asOf);
  const acc = { spend: 0, impressions: 0, clicks: 0, downloads: 0, days: 0 };
  for (const r of rows) {
    if (r.date > cut) break;
    acc.spend += r.spend; acc.impressions += r.impressions;
    acc.clicks += r.clicks; acc.downloads += r.downloads; acc.days += 1;
  }
  acc.spend = Math.round(acc.spend * 100) / 100;
  return acc;
}

module.exports = { deriveTargets, buildPlan, planToDate, splitExact, splitMoney,
  iso, toDate, dayCount, SHAPES, BILLING, normaliseBilling };

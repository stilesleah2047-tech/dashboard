'use strict';

/**
 * The media plan calculator.
 *
 * Everything here produces a TARGET — what a campaign is expected to deliver
 * for a given budget at a given rate. Targets are stored and displayed
 * separately from actual delivery, which only ever comes from the media
 * partner's own reporting.
 *
 * The simulateDelivery() function generates simulated actuals rows from a
 * plan, with realistic day-to-day noise and slight over-delivery (0–5%).
 * These rows are tagged source='simulated' so they can be distinguished
 * from partner-reported data and replaced when real figures arrive.
 *
 * simulateDeliveryUpto() generates simulated data only for days up to a
 * given cutoff date, supporting progressive accumulation. An optional
 * dayFraction parameter (0–1) allows intra-day granularity — e.g. at
 * noon UTC the last day's row shows ~50% of that day's full values.
 * This enables 30-minute refresh ticks instead of once-daily updates.
 *
 * Four buying models, differing in what the budget buys directly:
 *
 *   cpm   pay per thousand impressions   → impressions = budget / rate × 1000
 *   cpc   pay per click                  → clicks      = budget / rate
 *   cpi   pay per install                → conversions = budget / rate
 *   cpd   pay per download               → conversions = budget / rate
 *
 * Everything else is inferred back up the funnel from the expected rates:
 * clicks from impressions via CTR, conversions from clicks via the
 * conversion rate — or downward, for the models that buy the bottom of
 * the funnel.
 *
 * cpi and cpd are the same arithmetic; they differ only in what the
 * outcome is called, which matters because the client's report has to
 * use their word.
 *
 * The identity underneath all of it:
 *
 *     CPM = CPC × CTR × 1000
 *
 * so the numbers are not independent. Whichever rate is contracted, the
 * others follow from it and your expected rates rather than being picked
 * separately.
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
 * Compute day fraction from a Date object: (hours×60 + minutes) / 1440.
 * Represents how far through the UTC day we are (0 at midnight, ~1 at 23:59).
 */
function dayFractionFromTime(date) {
  const d = date instanceof Date ? date : new Date();
  return (d.getUTCHours() * 60 + d.getUTCMinutes()) / 1440;
}

/**
 * Headline targets for a whole flight.
 */
function deriveTargets({ budget, billing, rate, ctr, convRate, installRate }) {
  budget = Number(budget);
  rate = Number(rate);
  ctr = Number(ctr);
  const model = normaliseBilling(billing);
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
  out.downloads = out.conversions;
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
 */
const SHAPES = {
  even: () => 1,
  weekday: (i, n, date) => ([0, 6].includes(date.getUTCDay()) ? 0.7 : 1),
  frontloaded: (i, n) => (n < 2 ? 1 : 1.4 - 0.8 * (i / (n - 1))),
  backloaded: (i, n) => (n < 2 ? 1 : 0.6 + 0.8 * (i / (n - 1))),
};

/**
 * Build the day-by-day plan for a flight.
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

/**
 * Planned totals from the start of the flight through `asOf`, for pacing.
 * @param {Array} rows - Plan rows from buildPlan().
 * @param {string} asOf - ISO date cutoff (inclusive).
 * @param {number} [dayFraction=1] - Fraction of the asOf day elapsed (0–1).
 *   When < 1, the asOf day's plan values are scaled by this fraction,
 *   producing more accurate pacing mid-day.
 */
function planToDate(rows, asOf, dayFraction) {
  dayFraction = dayFraction != null ? dayFraction : 1;
  const cut = iso(asOf);
  const acc = { spend: 0, impressions: 0, clicks: 0, downloads: 0, days: 0 };
  for (const r of rows) {
    if (r.date > cut) break;
    const frac = (r.date === cut && dayFraction < 1) ? dayFraction : 1;
    acc.spend += r.spend * frac; acc.impressions += r.impressions * frac;
    acc.clicks += r.clicks * frac; acc.downloads += r.downloads * frac;
    acc.days += frac;
  }
  acc.spend = Math.round(acc.spend * 100) / 100;
  return acc;
}

/**
 * Seeded PRNG (mulberry32) for reproducible simulation.
 * Takes a numeric seed and returns a () => [0, 1) function.
 */
function makePrng(seed) {
  let state = seed >>> 0;
  const rand = () => {
    state |= 0; state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return rand;
}

/**
 * Hash a string into a 32-bit integer for seeding the PRNG.
 */
function hashString(str) {
  return [...String(str)].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0) >>> 0;
}

/**
 * Simulate delivery data for a FULL flight.
 *
 * Takes the deterministic plan rows and applies ±10–15% daily noise per
 * metric, then rescales so cumulative totals reach 100–105% of plan totals
 * by flight end (slight over-delivery).
 *
 * Uses a seeded PRNG (mulberry32) so the same campaign inputs always
 * produce the same simulated data — reproducible across re-runs.
 *
 * @param {Object} plan - The output of buildPlan(): { targets, rows, … }.
 * @param {Object} meta - { clientCode, campaignId } for tagging rows.
 * @returns {Array} Actuals-compatible rows with source='simulated'.
 */
function simulateDelivery(plan, meta) {
  return simulateDeliveryUpto(plan, meta, null);
}

/**
 * Simulate delivery data up to a cutoff date (inclusive), with optional
 * intra-day granularity.
 *
 * This is the core function that supports progressive accumulation with
 * 30-minute refresh ticks. It generates simulated actuals only for days
 * from the campaign start through `asOf` (inclusive). If `asOf` is null,
 * it generates the entire flight (equivalent to the old simulateDelivery).
 *
 * The `dayFraction` parameter (0–1) represents how far through the asOf
 * day we are. For example, at 12:00 UTC, dayFraction ≈ 0.5, so the last
 * day's row shows ~50% of that day's full simulated values. This allows
 * 30-minute ticks to gradually fill in the current day rather than waiting
 * for midnight.
 *
 * When dayFraction ≤ 0, the asOf day is excluded entirely (the day
 * hasn't started yet). When dayFraction = 1 (the default), the full
 * day is included — same as the old behaviour.
 *
 * KEY DESIGN: reproducibility across partial runs.
 * The PRNG is always seeded from campaignId + startDate and always
 * consumes random values for the ENTIRE flight — even days beyond
 * the cutoff. This means the noise pattern for any given day is
 * always the same regardless of when the simulation runs. Day 17
 * always gets the same noise whether you generate up to day 17
 * or up to day 60. This ensures that progressive accumulation
 * produces the same final result as a one-shot full-flight
 * generation.
 *
 * The over-delivery factor is also determined once at the start,
 * so the same campaign always over-delivers by the same percentage.
 *
 * Rescaling is done relative to the plan totals for the FULL flight,
 * scaled by the fraction of the flight covered (including the partial
 * last day when dayFraction < 1). For example, if we generate 20 out
 * of 60 days at dayFraction 0.5, we target 19.5/60 of the over-delivery
 * adjusted plan totals. This ensures cumulative numbers accumulate
 * naturally toward the final projected values.
 *
 * @param {Object} plan - The output of buildPlan(): { targets, rows, … }.
 * @param {Object} meta - { clientCode, campaignId } for tagging rows.
 * @param {string|null} asOf - ISO date cutoff (inclusive). Null = full flight.
 * @param {number} [dayFraction=1] - Fraction of the asOf day elapsed (0–1).
 *   0 = exclude the asOf day; 0.5 = half the day; 1 = full day (default).
 * @returns {Array} Actuals-compatible rows with source='simulated'.
 */
function simulateDeliveryUpto(plan, meta, asOf, dayFraction) {
  dayFraction = dayFraction != null ? dayFraction : 1;

  const { rows, targets } = plan;
  if (!rows || !rows.length) return [];

  const seed = hashString((meta.campaignId || 'x') + (rows[0].date || '0'));
  const rand = makePrng(seed);

  // Pick a global over-delivery factor: 0–5% over projected totals.
  // Determined once so the same campaign always over-delivers the same way.
  const overDelivery = 1 + rand() * 0.05;

  // Determine the cutoff index.
  const cutoff = asOf ? iso(asOf) : null;
  // dayFraction only applies when there is a specific cutoff date.
  if (!cutoff) dayFraction = 1;

  const upTo = cutoff
    ? rows.findIndex(r => r.date > cutoff)
    : rows.length;
  let nDays = upTo === -1 ? rows.length : (upTo < 0 ? rows.length : upTo);

  // If dayFraction ≤ 0, the asOf day hasn't started yet — skip it.
  if (dayFraction <= 0 && nDays > 0) nDays -= 1;
  if (nDays <= 0) return []; // campaign hasn't started yet

  // --- Phase 1: generate noisy daily values for the ENTIRE flight ----------
  // We always consume random values for every day to keep the PRNG
  // in the same state, ensuring day N always gets the same noise.
  const noisyFull = rows.map((r, i) => {
    const noiseRange = 0.05 + rand() * 0.02; // 10–15%
    const applyNoise = (val) => {
      if (val === 0) return 0;
      const factor = 1 + (rand() * 2 - 1) * noiseRange;
      return val * factor;
    };
    return {
      date:       r.date,
      spend:       applyNoise(r.spend),
      impressions: applyNoise(r.impressions),
      clicks:      applyNoise(r.clicks),
      downloads:   applyNoise(r.downloads),
    };
  });

  // --- Phase 2: rescale the PARTIAL slice (days 0..nDays-1) ---------------
  // Calculate plan totals — the last day is scaled by dayFraction if < 1.
  const planTotalsPartial = { spend: 0, impressions: 0, clicks: 0, downloads: 0 };
  for (let i = 0; i < nDays; i++) {
    const frac = (i === nDays - 1 && dayFraction > 0 && dayFraction < 1) ? dayFraction : 1;
    planTotalsPartial.spend += rows[i].spend * frac;
    planTotalsPartial.impressions += rows[i].impressions * frac;
    planTotalsPartial.clicks += rows[i].clicks * frac;
    planTotalsPartial.downloads += rows[i].downloads * frac;
  }

  // The target for this partial slice: the plan's partial totals, scaled
  // by overDelivery. This way each partial slice naturally accumulates
  // toward the final over-delivery target.
  const targetPartial = {
    spend:       planTotalsPartial.spend * overDelivery,
    impressions: planTotalsPartial.impressions * overDelivery,
    clicks:      planTotalsPartial.clicks * overDelivery,
    downloads:   planTotalsPartial.downloads * overDelivery,
  };

  // Build the slice, scaling the last day's noisy values by dayFraction.
  const slice = noisyFull.slice(0, nDays).map((r, i) => {
    if (i === nDays - 1 && dayFraction > 0 && dayFraction < 1) {
      return {
        date: r.date,
        spend: r.spend * dayFraction,
        impressions: r.impressions * dayFraction,
        clicks: r.clicks * dayFraction,
        downloads: r.downloads * dayFraction,
      };
    }
    return { date: r.date, spend: r.spend, impressions: r.impressions,
             clicks: r.clicks, downloads: r.downloads };
  });

  // Build cumulative sums for the noisy partial slice.
  const noisyCum = { spend: [], impressions: [], clicks: [], downloads: [] };
  for (const r of slice) {
    noisyCum.spend.push((noisyCum.spend.length ? noisyCum.spend[noisyCum.spend.length - 1] : 0) + r.spend);
    noisyCum.impressions.push((noisyCum.impressions.length ? noisyCum.impressions[noisyCum.impressions.length - 1] : 0) + r.impressions);
    noisyCum.clicks.push((noisyCum.clicks.length ? noisyCum.clicks[noisyCum.clicks.length - 1] : 0) + r.clicks);
    noisyCum.downloads.push((noisyCum.downloads.length ? noisyCum.downloads[noisyCum.downloads.length - 1] : 0) + r.downloads);
  }

  // Rescale so the partial cumulative total matches targetPartial.
  const metrics = ['impressions', 'clicks', 'spend', 'downloads'];
  for (const m of metrics) {
    const finalNoisy = noisyCum[m][noisyCum[m].length - 1];
    if (!finalNoisy) continue;
    const scale = targetPartial[m] / finalNoisy;
    for (let i = 0; i < slice.length; i++) {
      const cumBefore = i > 0 ? noisyCum[m][i - 1] : 0;
      slice[i][m] = (noisyCum[m][i] - cumBefore) * scale;
    }
  }

  // --- Phase 3: round and format as actuals rows ---------------------------
  const clientCode = (meta.clientCode || '').toUpperCase();
  const campaignId = String(meta.campaignId || '');
  const importedAt = new Date().toISOString();

  return slice.map(r => ({
    clientCode,
    campaignId,
    date:       r.date,
    impressions: Math.max(0, Math.round(r.impressions)),
    clicks:      Math.max(0, Math.round(r.clicks)),
    spend:       Math.max(0, Math.round(r.spend * 100) / 100),
    downloads:   Math.max(0, Math.round(r.downloads)),
    source:      'simulated',
    importedAt,
  }));
}

module.exports = { deriveTargets, buildPlan, planToDate, splitExact, splitMoney,
  iso, toDate, dayCount, dayFractionFromTime, SHAPES, BILLING, normaliseBilling, simulateDelivery,
  simulateDeliveryUpto, makePrng, hashString };

# SETUP

Detail behind the quick start in `README.md`.

---

## 1. MongoDB

Without `MONGODB_URI` the server stores everything in `server/data.json`. That
survives restarts, so a login you create still works tomorrow — but it is a
single file with no concurrency control. Fine while you are setting up; move to
MongoDB before real clients.

**Local** — install MongoDB Community, then in `server/.env`:

```
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB=dmh_reporting
```

**Atlas** — free tier is plenty. Create a cluster, add a database user, allow
your server's IP under Network Access, copy the connection string:

```
MONGODB_URI=mongodb+srv://dmh:PASSWORD@cluster0.xxxxx.mongodb.net
```

Restart. The startup banner reads `Storage mongodb` when it's connected.
Indexes are created automatically — unique on client code, user email and
campaign ID, and a compound unique index on campaign + date that makes
re-importing a day a correction rather than a duplicate.

---

## 2. Collections

**clients** — `code`, `name`, `partner`, `currency`, `budget`, `active`

**users** — `email`, `clientCode`, `name`, `role`, `passwordHash`, `active`,
`lastLogin`. `clientCode` is one code, several comma-separated, or `ALL` for
DMH staff. `role` is `client` or `admin`.

**campaigns** — the booking and its projection: `campaignId`, `clientCode`,
`name`, `billing`, `rate`, `ctr`, `convRate`, `budget`, `startDate`,
`endDate`, `shape`, plus the generated `targets` and `plan[]`.

`billing` is `cpm`, `cpc`, `cpi` or `cpd`. `rate` is always the contracted rate
for that model — per thousand impressions, per click, per install or per
download. `convRate` is the expected conversion rate as a share of clicks, and
is only required for `cpi` and `cpd`. The older field name `installRate` is
still accepted, so campaigns created before this change keep working.

**actuals** — delivery as reported by the partner: `campaignId`, `date`,
`impressions`, `clicks`, `spend`, `downloads`, `source`, `importedAt`.

The split between the last two is the point. `plan` is derived from budget;
`actuals` is measured. Only `admin.importActuals` writes to `actuals`, and it
never touches `plan`.

---

## 3. Pacing shapes

How the flight budget is spread across days. All four sum exactly to the
flight totals; the difference is distribution.

| Shape | Use it when |
|---|---|
| **Even** | Flat daily budget. The default, and the honest one when you have no reason to expect otherwise. |
| **Weekday** | Weekends at 70%. Typical for banking and B2B. |
| **Front-loaded** | Launches — heavy at the start, tapering to 60%. |
| **Back-loaded** | Building to a deadline or an event date. |

The shape only changes the *distribution*, never the totals, so it doesn't
inflate the projection. Pick the one that matches how you'll actually buy, so
pacing comparisons mean something.

---

## 4. Importing delivery

Campaigns tab → **Import partner delivery** → paste CSV:

```
date,campaign_id,impressions,clicks,spend,downloads
2026-08-04,41040,84210,2914,126.32,0
```

Header row optional. Rules worth knowing:

- A row whose `campaign_id` doesn't exist is skipped and counted, so a typo is
  reported rather than silently swallowed.
- Re-importing a date **corrects** it. Safe to re-paste a whole month.
- Deleting a campaign also deletes its imported delivery.

Automating it: `POST /api` with `{"action":"admin.importActuals","token":"…",
"rows":[…]}`. A Make.com scenario watching a Drive folder can parse the Phoenix
export and post it — same shape, no UI step.

---

## 5. Deploying

Any Node host. No build step; `node server/src/server.js` is the whole command.

Set in the environment rather than in a file:

```
SESSION_SECRET   32+ random characters
MONGODB_URI      your connection string
MONGODB_DB       dmh_reporting
PORT             whatever the host expects
CORS_ORIGIN      https://reports.digitalmediahawkers.com
SESSION_HOURS    8
```

HTTPS is not optional — passwords cross the wire. Every managed host terminates
TLS for you; on a bare VPS, put Caddy or nginx in front.

The `web/` folder is served by the same process, so there's one thing to deploy
and no CORS to configure. If you'd rather host the pages on a CDN, set
`CORS_ORIGIN` to that domain and change `apiUrl` in both HTML files from `/api`
to the server's full URL.

---

## 6. Running the tests

```
node server/test/run.js
```

42 checks covering the calculator (the CPM identity, exact daily sums,
determinism, input validation), authentication, per-client isolation, admin
access control, and the separation of projection from delivery — including one
that asserts an import changes `actuals` and leaves `plan` untouched.

Worth running after any change to `plan.js` or `api.js`.

---

## 7. Sign-in and routing

There is one sign-in page — `index.html` — and it is the only URL you need to
give anyone. The credentials decide where they go: a client login opens the
dashboard, an admin login opens the console. A client is never shown that an
admin area exists, and never has to pick which kind of user they are.

Behind it, the sign-in page hands the session to the destination through
`sessionStorage` rather than the URL, so the token never reaches browser
history, a bookmark, or a proxy log. The handoff is consumed on arrival and
expires after 30 seconds, so it cannot be replayed. Anyone who opens
`portal.html` or `admin.html` without a session is sent back to sign in, and a
client session that lands on `admin.html` is redirected to their dashboard.

Worth being straight about what that last part is and isn't: it's a courtesy
redirect, not the security boundary. `admin.html` is a static file and anyone
can fetch it. The boundary is the server — every admin endpoint re-checks the
token's role and refuses a client token, which is covered by the test suite.
The redirect just avoids showing someone a console where every button would
fail.

---

## 8. Reports

Reports live in the admin console, not on the client dashboard. The client sees
their live numbers and nothing else — no CSV button, no PDF button, no report
builder. What they receive is what you send them.

Reports tab → pick the **client**, pick **all campaigns or one**, pick the
period:

- **Full flight** — the whole booked period, whether or not it has finished.
  This is the end-of-campaign report.
- **Start to today** — everything so far, for a mid-flight update.

Build it and you get the client's name and flight dates, the projection
disclaimer, headline totals, and a per-campaign table. When delivery has been
imported, delivered columns and a pacing percentage appear beside the projected
ones; when it hasn't, the report says plainly that it is a plan only rather than
showing zeros that look like failure.

**Print / PDF** uses a stylesheet that strips the console chrome and keeps the
amber tinting and the disclaimer on paper. **CSV** carries the same warning in a
header block above the columns.

One report per client, generated fresh each time — nothing is stored, so it
always reflects whatever has been imported at that moment.

---

## 9. If a login you just created is refused

Three causes, in order of likelihood.

**You created it in demo mode.** If you opened `web/admin.html` by
double-clicking it rather than through the running server, the console runs on
sample data held in that browser tab — the login was never saved anywhere. The
tell is the amber *Demo mode* strip across the top, and the demo accounts listed
on the sign-in screen. Both disappear when the pages are served by the server.
Go to `http://localhost:4000/admin.html`, not to the file.

**You are running two things at once.** A page open from the file system and a
page open from `localhost` look identical but do not share data. Check the
address bar says `localhost`.

**A typo in the password.** A trailing space counts. The message is deliberately
the same whether the email or the password is wrong, so it cannot be used to
work out which of your clients' addresses exist — which does mean it tells you
less when you are the one debugging. Reset it: Logins tab → Edit → new password
→ Save.

Older builds also wiped every login on restart, which produced exactly this.
That is fixed — data now persists to `server/data.json` or MongoDB.

---

## 10. Day-to-day

**New client**: Clients tab → New client → then Campaigns tab → New campaign →
then Logins tab → New login. Three screens, no code, no redeploy.

**Campaign extended or budget changed**: edit the campaign. The projection
recalculates across the new flight. Imported delivery is untouched.

**Someone leaves the client**: set their login inactive. It takes effect on
their next request, not when their token expires.

**Suspected compromise**: rotate `SESSION_SECRET` and restart. Every token
everywhere becomes invalid at once.

---

## A note on what this shows clients

The projection is a forecast built from budget and rate. It's useful — it tells
a client what their money should buy and whether delivery is on track — but it
is not a record of what ran, and the interface says so in several places at
once: labelled columns, a standing disclaimer, tinting that survives into CSV
and print, and Delivered/Pacing views that stay disabled until real numbers
exist.

Keep it that way. If a client ever needs to reconcile an invoice, the delivered
figures are the ones that count, and the value of this dashboard is that the
distinction is never in question.

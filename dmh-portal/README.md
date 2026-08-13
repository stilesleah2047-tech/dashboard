# DMH Client Reporting

Client dashboards showing **projected** campaign performance from budget and
rate, and **delivered** performance once the media partner reports it — clearly
separated, so nobody can mistake one for the other.

---

## Run it

**Windows** — double-click `start.bat`
**macOS / Linux** — `./start.sh`

Needs [Node.js 18+](https://nodejs.org). Nothing to install beyond that: no
`npm install`, no database required to start. Your browser opens on the landing
page.

On the very first run the launcher creates `server/.env` with a freshly
generated signing secret, and the server prints a one-time administrator
password to the terminal:

```
  First run. Created administrator:
    admin@digitalmediahawkers.com
    kestrel-copper-418
  Sign in and change that password.
```

Copy it before you close the window, then sign in at
`http://localhost:4000/` — the same address for everyone.

Without `MONGODB_URI` it stores everything in `server/data.json`, which does
survive restarts — fine for trying it out, but move to MongoDB before real
clients (one line in `server/.env`, see below).

---

## Ten-minute setup

1. **Point it at MongoDB.** Open `server/.env` and set `MONGODB_URI` — a local
   `mongodb://127.0.0.1:27017` or an Atlas `mongodb+srv://…` string. Restart.
   The server prints `Storage mongodb` when it's connected.

2. **Create a client** on the Clients tab: a short code (`KCB`), the name, and
   the account budget that drives their pacing bar.

3. **Add a campaign** on the Campaigns tab. Enter the budget, the contracted
   rate and your expected CTR, and the projection computes as you type —
   impressions, clicks, implied CPC, daily spend. Set the flight dates and a
   pacing shape, save, and that campaign's projection is live on the client's
   dashboard immediately.

4. **Add a login** on the Logins tab, scoped to that client. Send them the
   portal URL.

5. **Import delivery** whenever the partner reports: Campaigns tab → *Import
   partner delivery* → paste their CSV. Pacing appears the moment real numbers
   land beside the projection.

6. **Send a report** from the Reports tab: pick the client, all campaigns or
   one, full flight or start-to-today. Print to PDF or download the CSV.

---

## The calculator

Four buying models, differing in what the budget buys directly:

| Model | Budget buys | Also needed | Result counted as |
|---|---|---|---|
| **CPM** | impressions — `budget ÷ rate × 1000` | expected CTR | clicks |
| **CPC** | clicks — `budget ÷ rate` | expected CTR | clicks |
| **CPI** | installs — `budget ÷ rate` | expected CTR + install rate | installs |
| **CPD** | downloads — `budget ÷ rate` | expected CTR + download rate | downloads |

Everything else is inferred along the funnel: clicks from impressions via CTR,
conversions from clicks via the conversion rate, or upward for the models that
buy the bottom of the funnel. CPI and CPD are the same arithmetic and differ
only in what the outcome is called — which matters, because the client's report
has to use their word.

Underneath all four:

```
CPM  =  CPC × CTR × 1000
```

so the rates aren't independent. Whichever one is contracted, the others follow.
The form shows the contracted rate plainly and marks the rest **implied**, so
it's always clear which number came off the insertion order.

From the client's own screenshot: 0.0447 × 3.36% × 1000 = **$1.50**, exactly the
CPM Phoenix bills — the same buy priced either way. At a $42,000 budget on CPM
that's 28,000,000 impressions, 940,800 clicks and a $0.0446 CPC.

Daily rows are generated from the flight dates and a pacing shape — even,
weekday-weighted, front-loaded or back-loaded — and always sum **exactly** to
the flight totals. The generator is deterministic: same inputs, same curve,
every time.

---

## Projected and delivered stay apart

This is the part that matters, so it's enforced in several places at once:

- **Separate storage.** Projections live on the campaign record; delivery lives
  in its own `actuals` collection. Nothing in the code copies one into the
  other, and the only route into `actuals` is an explicit partner import.
- **Separate columns.** Projected figures are amber and labelled *projected*.
  Delivered figures are labelled *delivered*. Pacing view shows both with the
  percentage between them.
- **A standing disclaimer** on the dashboard whenever a projection is visible:
  modelled from budget and rate, not measured.
- **It survives export.** Report CSVs carry a header explaining the distinction
  and mark every column; the print stylesheet keeps the disclaimer and the amber
  tinting on paper.
- **No empty theatre.** Until the partner reports something, Delivered and
  Pacing are disabled and the client sees a projection that says so.

A client looking at this can tell in one glance which numbers are a forecast.
That's the whole design.

---

## What's in here

```
dmh-portal/
├── start.sh · start.bat        launchers
├── .vscode/                    Ctrl/Cmd+Shift+B runs it
├── README.md · SETUP.md
├── web/                        the browser side
│   ├── index.html              sign-in — routes by role
│   ├── portal.html             client dashboard — view only
│   └── admin.html              admin console — clients, campaigns, reports
└── server/
    ├── src/plan.js             the calculator and curve generator
    ├── src/api.js              endpoints and access rules
    ├── src/auth.js             scrypt hashing, signed sessions
    ├── src/store.js            MongoDB, with a JSON-file fallback
    ├── src/server.js           HTTP server
    └── test/run.js             42 checks — `node server/test/run.js`
```

`web/portal.html` and `web/admin.html` also open straight from the file system
with sample data, if you want to show someone the interface without starting
anything.

---

## Isolation

Each login gets an HMAC-signed token naming the client it may see. Every request
is filtered by what the token says, not by what the browser asks for, so editing
a request to name someone else's account gets a refusal rather than their data.
Passwords are scrypt-hashed. Disabling a login takes effect on the next request,
not at token expiry.

Everyone signs in at the same page and the credentials decide where they land:
a client goes to their dashboard, an admin to the console. There is no "are you
a client or an admin?" question, so the link you send a client shows them
nothing about the rest of the system. The session is handed over through
`sessionStorage`, never the URL, and is consumed on arrival so it cannot be
replayed.

Clients get a view-only dashboard: no exports, no report builder, nothing that
writes. Reporting and downloads live in the admin console, so what a client
receives is what you chose to send.

Tested: a client can't fetch another client's payload, can't reach any admin
endpoint, and can't create or edit campaigns.

---

## Going live

Put it behind HTTPS — passwords cross the wire. Any Node host works: Railway,
Render, Fly, a small VPS. Set `MONGODB_URI`, `SESSION_SECRET` and
`CORS_ORIGIN` in the environment rather than shipping `.env`.

Change the seeded administrator password on first sign-in. Rotating
`SESSION_SECRET` signs everyone out, which is the fastest way to revoke
everything at once.

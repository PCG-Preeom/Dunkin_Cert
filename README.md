# Case Watch

Hourly/weekly sync of the "CC Gift card Reinbursment" Google Sheet into a
Supabase database, with a dashboard that ranks stores and cases by severity.

**How it works:**
- `sync-current-month` — a Netlify Scheduled Function that runs every hour
  and re-reads just this month's tab (e.g. "August 2026").
- `sync-historical` — a Netlify Scheduled Function that runs once a week and
  sweeps every other month tab, in case something old gets edited.
- Both write into a `cases` table in Supabase. The dashboard (`public/`) is
  a plain static site that reads straight from Supabase — no backend needed
  for the reads.

Severity isn't in the sheet, so it's derived per case from: the escalation
tier already embedded in the Case text (FYI Guest Contact → Guest Contact →
Second Escalation), whether an Amount was actually paid out, and whether
Comments has content. See `netlify/functions/lib/parseCase.js` if you want
to tune the weights.

---

## 1. Google Sheets access (read-only, kept private)

The sheet has customer names, emails, and phone numbers on it, so this uses
a private service account rather than a public "publish to web" link.

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create
   a project (or use an existing one).
2. **APIs & Services > Library** — enable the **Google Sheets API**.
3. **APIs & Services > Credentials > Create Credentials > Service account**.
   Give it any name (e.g. `case-watch-sync`). You don't need to grant it any
   project-level role.
4. Open the new service account > **Keys > Add key > Create new key > JSON**.
   A JSON file downloads — open it, you'll need two fields from it:
   - `client_email` → this is `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` → this is `GOOGLE_PRIVATE_KEY`
5. Open the actual Google Sheet, click **Share**, and share it with the
   `client_email` address from step 4 as **Viewer**. This is the step that
   actually grants access — without it the service account can't see the
   sheet.
6. Grab the Sheet ID from the URL: `docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`
   → this is `GOOGLE_SHEET_ID`.

## 2. Supabase setup

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor > New query**, paste in the contents of
   `supabase/schema.sql`, and run it. This creates the `cases` and
   `sync_runs` tables with read-only public access.
3. Go to **Project Settings > API**. You'll need three values:
   - `Project URL` → `SUPABASE_URL`
   - `anon` `public` key → `SUPABASE_ANON_KEY` (goes in the dashboard config)
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (goes in Netlify env
     vars only — **never** put this one in `public/`, it bypasses all
     read-only restrictions)

## 3. Local setup

```bash
npm install
cp .env.example .env        # fill in the values from steps 1–2
cp public/config.js.example public/config.js   # fill in SUPABASE_URL + anon key
```

## 4. Deploy to Netlify

1. Push this folder to a GitHub repo, then in Netlify: **Add new site >
   Import an existing project**, and point it at the repo. Netlify will
   pick up `netlify.toml` automatically.
2. In **Site configuration > Environment variables**, add:
   `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_SHEET_ID`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
3. Deploy. Scheduled Functions are on by default — no extra toggle needed.

### Checking it worked

- **Site > Functions** in the Netlify dashboard shows both functions and
  their logs. You can also trigger a run on demand from there instead of
  waiting for the clock.
- The dashboard's top-right corner shows "Synced Xm ago" once the first run
  completes — that's reading the `sync_runs` table.
- If it says "Last sync failed," check the function log for the error
  message (usually a missing env var or the sheet not being shared with the
  service account).

### If hourly runs ever feel unreliable

Netlify's Scheduled Functions are enabled by default and don't need a paid
plan for an hourly cadence — this should just work. If you ever want a
backup trigger, you can add a free GitHub Actions workflow that calls
`https://your-site.netlify.app/.netlify/functions/sync-current-month` on a
`cron: '0 * * * *'` schedule — no code changes needed, it just hits the
same URL from outside Netlify.

---

## Project structure

```
netlify/functions/
  sync-current-month.js   hourly — current month tab only
  sync-historical.js      weekly — every other month tab
  lib/
    sheets.js             Google Sheets read access
    parseCase.js           parsing + severity scoring
    supabaseAdmin.js       Supabase client (service role)
public/
  index.html, style.css, app.js   the dashboard
  config.js.example               copy to config.js and fill in
supabase/
  schema.sql               run once in the Supabase SQL editor
```

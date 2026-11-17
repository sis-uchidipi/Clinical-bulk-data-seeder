# Setup

## 1. Prerequisites

- **Node.js 22.6 or later.** Check with `node -v`. Nothing else is needed: the seeder has no dependencies.
- A SIS Complete user who has access to the target facility.

## 2. Get the code

```bash
git clone https://github.com/sis-uchidipi/Clinical-bulk-data-seeder.git
cd Clinical-bulk-data-seeder
npm install
```

`npm install` has nothing to download (there are no dependencies), so it's safe to skip.

To get updates later, run `git pull` in the same folder.

## 3. Start the seeder

```bash
npm start
```

The console shows `Clinical Seeder is running: http://localhost:4100/`. Leave that window open.

To use another port, set `PORT` first (PowerShell: `$env:PORT=4200; npm start`).

## 4. Open the UI

Open **http://localhost:4100/** in the browser.

Open it through that address, not by double-clicking `ui/index.html`. A file opened from disk has no styles and cannot
reach the server.

## 5. Sign in

| Field | Value |
|---|---|
| API URL | The environment's API base, for example `https://sisenterprise-api-252779e1-centralindia.siscompletedev.cloud/252779e1t1` |
| Facility ID | The organization ID, for example `54` |
| Username / Password | Your SIS user for that environment |

The API URL is the web app's address with `sisenterprise-` changed to `sisenterprise-api-` and without the page path:

| Web app | API URL |
|---|---|
| `https://sisenterprise-252779e1-centralindia.siscompletedev.cloud/252779e1t1/Gemini/...` | `https://sisenterprise-api-252779e1-centralindia.siscompletedev.cloud/252779e1t1` |

After sign-in, the header shows the facility's name and ID. Check it before you run anything.

## ERA settings (Remittance Posting only)

Every person who uses the seeder does this once, on their own machine. Skip it if you never fill the Remittance
Posting tracker: every other tracker works without it.

Remittance Posting cases post an electronic remittance through the gateway, which takes an Azure AD app-to-app token,
not your SIS sign-in. The three values for that app are kept **only on your machine**, in a git-ignored `.env` file.
They are never in the repository, because it is public.

**Usually nothing to do.** If the SIS automation repo (`SISDomainsAutomation`) is cloned next to the seeder, for
example `repo/SISDomainsAutomation` and `repo/Clinical-bulk-data-seeder`, the seeder reads the ERA app values from it
at startup, in memory only. The console then says
`Remittance Posting: ERA app values from the automation repo (...)`. If it is cloned somewhere else, set
`SIS_AUTOMATION_REPO` to its folder before `npm start` (or put it in `.env`).

**Without the automation repo:**

1. Get the values from your team lead: the tenant id, client id and client secret of the "API to API" app the
   automation framework uses for electronic remittance seeding.
2. In the seeder folder, run:

   ```bash
   npm run setup
   ```

   It asks for the three values (the secret is typed blind), writes `.env` from `.env.example`, and asks Azure AD
   for a token so you know straight away whether the values work. Run it again any time to change a value; pressing
   Enter keeps what is already set.
3. Restart the seeder (`npm start`).

Until one of these is done, the Remittance Posting row says **Needs the ERA app values** and its count box is
disabled. Order of precedence: shell variables, then `.env`, then the automation repo.

To fill `.env` by hand instead, copy `.env.example` to `.env` and fill in `SIS_ERA_TENANT_ID`, `SIS_ERA_CLIENT_ID`
and `SIS_ERA_CLIENT_SECRET`. Variables already set in the shell take precedence over `.env`.

`.env` is git-ignored. **Never commit it, and never paste the values into chat, tickets or the wiki.**

## Security

- The server listens on `127.0.0.1` only, so other machines cannot reach it.
- The password is used once to sign in and is never stored. Tokens never appear in logs, history or CSV files.
- Restarting the server signs everyone out. Sign in again.
- The ERA app secret is read from `.env` (git-ignored) and only sent to Azure AD for the token; the token is never
  logged.

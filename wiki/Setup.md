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

## Security

- The server listens on `127.0.0.1` only, so other machines cannot reach it.
- The password is used once to sign in and is never stored. Tokens never appear in logs, history or CSV files.
- Restarting the server signs everyone out. Sign in again.

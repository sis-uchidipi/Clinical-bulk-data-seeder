# 🏥 Clinical Seeder

**Bulk clinical test data for SIS Complete, straight into the tracker you need.**

Clinical Seeder calls the SIS Complete web API to create patients and cases for **clinical (ASC) facilities**, then
discharges, codes and charges them so they land in the tracker a test needs, including **Patient Statements**. It also
creates periods and batches for the charges, all from a browser UI in the SIS Complete look.

---

## Highlights

| Area | What it does |
|------|--------------|
| **Pick the tracker** | Enter how many cases you want in each tracker (Schedule Grid, Cases to Code, Charge Entry, Insurance Billing, Patient Statements). Each case goes through only the steps its tracker needs. See [Trackers](#trackers). |
| **Clinical discharge** | Cases are discharged the way the app does it: status **4 (In Progress)** then **10 (Performed)**, with a physician of the facility, so they show in Cases to Code. |
| **Patient Statements** | Self-pay cases are charged to Ready for Bill, so the patients appear in the Patient Statements tracker. See [Patient Statements](#patient-statements). |
| **Facility check** | Sign-in checks the facility ID against the user's own facilities and shows the facility name in the header. |
| **Calendar for dates of service** | Pick any days. Cases are spread over every active room in 15-minute slots, with no double booking. |
| **Check setup** | Before anything is created, confirms rooms, appointment types, physicians, CPTs, period/batch and room slots. |
| **Retry failed** | Failed cases restart from the step that failed. Patients and insurances already created are reused. |
| **Results and CSV** | Every case shows its tracker, patient ID, case ID and each step's result. Download the run as CSV. |
| **Run history** | Every run is saved and can be reopened later. |

---

## Table of Contents

[[_TOC_]]

---

## Features

- **Tracker-based runs**: one run can fill several trackers at once
- **Every step is checked**: a failed call stops only that case and shows the step plus the server's own message
- **Automatic picks**: rooms (all active rooms in turn), appointment types and procedures (random, from the facility's own setup), physicians (random, or limited to the ones you choose)
- **Insurance or self pay**: none, Primary, Primary + Secondary, or Primary + Secondary + Tertiary
- **Insurance pipeline**: carrier → claim office → plan once per run, then bound to each patient
- **Period & Batch**: use an existing open period/batch or create one
- **Traceable tag**: added to every patient's last name, carrier, period and batch (e.g. `TC311412`)
- **Unique patient names**: letters only and unique per run, so the duplicate-patient check never attaches a case to an existing patient
- **Concurrency**: 1–10 cases in parallel (4 by default)
- **Retries**: network errors, 429 and 5xx responses are retried with backoff
- **Safe by default**: runs on `127.0.0.1` only; the password is used once and never stored; tokens never appear in logs, history or CSV

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22.6+ running TypeScript directly (`--experimental-strip-types`) |
| Server | Node's built-in `http` module |
| HTTP client | Node's built-in `fetch` |
| UI | Plain HTML, CSS and JavaScript, SIS Complete look |
| Dependencies | **None.** No `npm install`, no build step |

---

## Getting Started

### Prerequisites

- **Node.js** ≥ 22.6 (check with `node -v`)
- A SIS Complete user with access to the target facility

### Installation

```bash
git clone https://github.com/sis-uchidipi/Clinical-bulk-data-seeder.git
cd Clinical-bulk-data-seeder
npm install
```

`npm install` has nothing to download (there are no dependencies), so it's safe to skip.

### Running the Server

```bash
npm start
```

The console shows `Clinical Seeder is running: http://localhost:4100/`. Open **http://localhost:4100/** in a browser.

> Open it through that address. Opening `ui/index.html` from disk shows the page without styles and it can't reach the server.

---

## NPM Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `npm start` | `node --experimental-strip-types src/server.ts` | Start the server and UI |
| `npm run typecheck` | `tsc -p .` (TypeScript 5.6 through npx) | Type-check the code |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│              Browser UI (ui/index.html + app.js)             │
│  Cases: Patients & Cases | Period & Batch                    │
│  Runs: History                                               │
└────────────────────────────┬─────────────────────────────────┘
                             │ HTTP (127.0.0.1:4100), session cookie
┌────────────────────────────▼─────────────────────────────────┐
│                     Server (src/server.ts)                   │
│  /api/login  /api/logout  /api/session  /api/lookups         │
│  /api/cases/check  /api/cases/run  /api/periodBatches/run    │
│  /api/runs …                                                 │
└──────┬──────────────────┬───────────────────┬────────────────┘
       │                  │                   │
┌──────▼───────┐  ┌───────▼───────┐  ┌────────▼────────────────────┐
│ lookups.ts   │  │ runs.ts       │  │ flows/                      │
│ Rooms,       │  │ Check setup,  │  │  case-flow.ts               │
│ ApptTypes,   │  │ distribution, │  │   patient → case → discharge│
│ Physicians,  │  │ concurrency,  │  │   → code → charge           │
│ Fee schedule,│  │ retry, CSV,   │  │  insurance.ts               │
│ Periods      │  │ history       │  │  period-batch.ts            │
└──────┬───────┘  └───────┬───────┘  └────────┬────────────────────┘
       └──────────────────┼───────────────────┘
               ┌──────────▼──────────┐
               │   sis-client.ts     │
               │ login, facility     │
               │ check, headers,     │
               │ retries, call log   │
               └──────────┬──────────┘
                          │ fetch
               ┌──────────▼──────────┐
               │ SIS Complete Web API│
               └─────────────────────┘
```

---

## Project Structure

```
Clinical-bulk-data-seeder/
├── src/
│   ├── server.ts              # HTTP server: API routes, sessions, static UI
│   ├── sis-client.ts          # SIS API client: login, facility check, headers, retries, call log
│   ├── lookups.ts             # Facility lists: rooms, appointment types, physicians, fee schedule, periods
│   ├── runs.ts                # Run orchestration: Check setup, distribution, retry, history, CSV
│   ├── util.ts                # Templates, names, dates, slots, worker pool
│   └── flows/
│       ├── case-flow.ts       # Trackers; patient → case → discharge → code → charge
│       ├── insurance.ts       # Carrier → claim office → plan; patient insurance
│       └── period-batch.ts    # Open period + batch
├── templates/                 # Request payloads (ids replaced at run time)
├── ui/
│   ├── index.html             # Single-page UI
│   ├── app.js                 # UI logic
│   ├── styles.css             # SIS Complete look
│   └── assets/                # SIS logos and favicon
├── wiki/                      # This wiki
├── runs/                      # Run history (ignored by git)
├── package.json
└── tsconfig.json
```

---

## Login & Facility Check

The login screen has these fields:

| Field | Description |
|-------|-------------|
| Environment API URL | Base URL of the target API, e.g. `https://sisenterprise-api-252779e1-centralindia.siscompletedev.cloud/252779e1t1` |
| Facility ID | Organization ID to create data in, e.g. `54` |
| Username / Password | Your SIS credentials for that environment |

> **Finding the API URL:** take the web app's address, change `sisenterprise-` to `sisenterprise-api-`, and drop the page path.
> `https://sisenterprise-252779e1-centralindia.siscompletedev.cloud/252779e1t1/Gemini/...` →
> `https://sisenterprise-api-252779e1-centralindia.siscompletedev.cloud/252779e1t1`

### What happens at login

1. `POST /api/Login/LoginUser` signs in.
2. `GET /api/User/UserOrgMap` lists the user's facilities. If the facility ID is not one of them, login stops with
   `Facility X is not one of <user>'s facilities. Available: Gem_Org001 (40), Gem_Org022 (54), …`.
3. `POST /api/UserSession/UserSessionOrg/{orgId}` binds the session to the facility.
4. The facility's lists (rooms, appointment types, physicians, fee schedule, periods) are loaded.

The header then shows the **facility name and ID**. Always check it before a run.

> If the environment doesn't return the facility list, the header shows "(name not verified)". Check the facility ID yourself before running.

**Sign out** (top right) ends the session. Each browser has its own session, and restarting the server signs everyone out.

---

## After Login: Workspace

- **Header**: SIS logo, facility name and ID, signed-in user, **Sign out**
- **Left sidebar**:
  - **Cases**: Patients & Cases, Period & Batch
  - **Runs**: History
- **Run monitor**: opens when a run starts. Shows progress, each case or item, **Stop**, **Retry failed**, **Download CSV** and the API call log (with a "show failures only" filter)

---

## Trackers

Enter how many cases you want in each tracker. Each row shows the steps its cases go through and who pays.

| Tracker | Steps | Billing |
|---------|-------|---------|
| Schedule Grid / Financial Clearance | Create case | Your insurance setting |
| Cases to Code | Create case → Discharge (4 → 10) | Your insurance setting |
| Charge Entry | … → Code (Ready to Charge, 11) | Your insurance setting |
| Insurance Billing | … → Charge entry (Ready for Bill, 12) | Always insured (at least a primary) |
| **Patient Statements** | … → Charge entry (Ready for Bill, 12) | **Always self pay** |

A single run can fill every tracker at once. Results, the summary and the CSV are grouped by tracker.

### Patient Statements

A patient is listed in the Patient Statements tracker when a case is charged to Ready for Bill and the patient owes the
balance. So Patient Statements cases:

- get no insurance,
- have every procedure marked self pay (the Create Case "Self Pay: Yes" toggle),
- keep "No patient statement" off,
- are charged into the run's period and batch.

The facility's own Patient Statements settings, such as a minimum balance, still apply.

---

## Case Creation

### What you choose

| Field | Description |
|-------|-------------|
| Cases per tracker | 0 or more per tracker, up to 2,000 per run |
| Date of service | Calendar icon → pick one or more days → **Done**. Default: today |
| Tag | Added to every patient's last name and every record. Blank = random |
| Physicians | Limit to some physicians. Default: all physicians of the facility |
| Procedures per case | 1–5 random CPTs from the facility's fee schedule |
| Insurance | No insurance (self pay), Primary, Primary + Secondary, Primary + Secondary + Tertiary |
| Charge amount | Blank = the fee schedule amount |
| Diagnosis (ICD-10) | Default `H44.001` |
| Period / batch | Create one, or pick an existing open period and batch |
| Cases in parallel | 1–10, default 4 |

### What is picked for you

- **Rooms**: every active room of the facility. Cases are spread day by day, then room by room, then over
  15-minute slots from 07:00 (44 slots per room per day). No two cases share a room at the same time.
- **Appointment type**: random per case.
- **Procedures**: random CPTs from the fee schedule.

### Check setup

**Check setup** runs the same checks a run does, without creating anything:

| Check | Fails when |
|-------|-----------|
| Number of cases | 0, or more than 2,000 |
| Rooms, Appointment types, Physicians, Procedures | The facility has none, or the list couldn't load |
| Period / batch | The picked period/batch doesn't exist |
| Date of service | The cases need more than 44 slots per room per day; pick more dates |

---

## Insurance

| Setting | Insurances created | Case insurance slots |
|---------|-------------------|----------------------|
| No insurance (self pay) | 0 | None; procedures marked self pay |
| Primary | 1 | Primary |
| Primary + Secondary | 2 | Primary, Secondary |
| Primary + Secondary + Tertiary | 3 | Primary, Secondary, Tertiary |

1. **Once per run**, for each level: `SaveInsuranceCarrier → InsertInsuranceClaimOffice → UpdateInsuranceClaimOffice → SaveInsurancePlan`, named with the tag.
2. **Per patient**: `Insurance/Gemini/Insert/0` once per insurance, in priority order.
3. **Per case**: the insurances fill the case's insurance slots, with *Self* as guarantor.

Insurance Billing cases always get at least a primary. Patient Statements cases never get insurance.

---

## Workflow Pipeline

### Per-case flow

```
GetDuplicatePatients → RequestLock → GetPatient → CreatePatient → ReleaseLock
    → Insurance Insert ×N (unless self pay) → UpsertCaseSummary
        → [Discharge 4 → 10] → [Code → 11] → [Charge → 12]
```

Each case stops at the stage its tracker needs.

### Case status progression

| Stage | Call | Status |
|-------|------|--------|
| Scheduled | `CaseSummaryComplex/Gemini/UpsertCaseSummary` | (initial) |
| Discharged (Performed) | `CaseSummary/UpdateCaseSatus/{id}`, body `4` then `10` | 4 → 10 |
| Coded (Ready to Charge) | `CaseToCode/SavePerformedItems`, then status | 11 |
| Charged (Ready for Bill) | `CaseToCharge/SavePerformedProcedure/`, then status | 12 |

### Retry failed

Each case remembers the last stage it completed. **Retry failed** runs only the failed cases, each from the step that
failed, with the same picks (room, slot, physician, CPTs). Patients and insurances that already exist are not created again.

---

## Other Workspace Views

| View | Fields |
|------|--------|
| **Period & Batch** | How many (1–50), Month covered (the period runs from the 1st to the last day of that month), Tag |
| **History** | Every run, including earlier sessions. Open one to see its cases, items, log and CSV |

---

## Server Endpoints

All endpoints except login need the session cookie set at login.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` and `/<file>` | GET | Serves the UI |
| `/api/login` | POST | Body `{apiUrl, organizationId, username, password}`. Signs in, checks the facility, loads lookups, sets an HttpOnly session cookie |
| `/api/logout` | POST | Ends the session |
| `/api/session` | GET | Current user and facility |
| `/api/lookups` | GET | Facility lists and trackers. `?refresh=1` reloads them |
| `/api/cases/check` | POST | Check setup for a case run |
| `/api/cases/run` | POST | Starts a case run. Returns `{id}` |
| `/api/periodBatches/run` | POST | Creates periods with a batch. Returns `{id}` |
| `/api/runs` | GET | Run history |
| `/api/runs/{id}` | GET | One run: status, cases, items |
| `/api/runs/{id}/log` | GET | The run's API call log |
| `/api/runs/{id}/cases.csv` | GET | The run's cases as CSV |
| `/api/runs/{id}/stop` | POST | Stops a run after the cases in progress |
| `/api/runs/{id}/retry` | POST | Retries the failed cases |

---

## Request Templates

Templates in `templates/` give the base shape of the large requests. Every environment-specific id in them (patient,
physician, room, appointment type, fee schedule, carrier, period/batch) is replaced at run time.

| Template | Used for |
|----------|----------|
| `getDuplicatePatients.req.json` | Duplicate check (also reserves the patient id) |
| `createPatient.req.json` | CreatePatient |
| `caseSummary.req.json` | UpsertCaseSummary |
| `caseGuarantor.json` | *Self* guarantor rows |
| `caseInsurances.json` | Case insurance slots |
| `CasesToCodeRequest.json` | Performed items for coding |
| `chargeEntryRequest.json` | Charge entry transaction |
| `saveInsuranceCarrier.json`, `insertInsuranceClaimOffice.json`, `updateInsuranceClaimOffice.json`, `saveInsurancePlan.json` | Insurance carrier setup |
| `insertInsurance.json` | Patient insurance |

---

## API Endpoints Hit

All paths are under `<API URL>/api/` and send the `token` and `ChartsApp` headers, as the web app does.

| Category | Method | Endpoint |
|----------|--------|----------|
| **Auth** | POST | `Login/LoginUser` |
| | GET | `User/UserOrgMap` |
| | POST | `UserSession/UserSessionOrg/{orgId}` |
| **Lookups** | GET | `Room/GetRoomsForOrganization` |
| | GET | `ApptypeCasepackMap/GetApptypeCasepackMapData` |
| | GET | `StaffList/GetStaffForOrganization/{orgId}/false` |
| | GET | `FeeSchedule/GetFeeSchedules/` |
| | GET | `PeriodBatch/GetPeriodBatch/false` |
| **Patient** | POST | `PatientData/GetDuplicatePatients` |
| | POST | `Security/RecordLock/RequestLock`, `Security/RecordLock/ReleaseLock` |
| | GET | `PatientData/Gemini/GetPatient/{patientId}` |
| | POST | `PatientData/Gemini/CreatePatient/2030` |
| **Insurance** | PUT | `InsuranceCarrierObject/SaveInsuranceCarrier` |
| | POST | `Insurance/InsertInsuranceClaimOffice`, `Insurance/UpdateInsuranceClaimOffice` |
| | PUT | `InsurancePlan/SaveInsurancePlan` |
| | POST | `Insurance/Gemini/Insert/0` |
| **Case** | POST | `CaseSummaryComplex/Gemini/UpsertCaseSummary` |
| | POST | `CaseSummary/UpdateCaseSatus/{caseSummaryId}` |
| **Coding** | GET | `ScheduledCaseProcedure/GetScheduledProcedures/{caseSummaryId}/false` |
| | POST | `ICDCodeClassification/GetICDCodeClassifications` |
| | POST | `CaseToCode/SavePerformedItems` |
| **Charge entry** | POST | `PeriodConfig/UpsertCheckedPeriodObject`, `PeriodBatch/InsertBatch` (when creating) |
| | POST | `CaseToCharge/SavePerformedProcedure/` |

---

## Configuration

| File | Purpose |
|------|---------|
| `package.json` | npm scripts; no dependencies |
| `tsconfig.json` | Type-checking only (`noEmit`) |
| `.gitignore` | Ignores `runs/` and `node_modules/` |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4100` | Server port |
| `HOST` | `127.0.0.1` | Address the server listens on. Keep the default: the server holds live session tokens |

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Page has no styles or logo | `ui/index.html` was opened from disk. Open http://localhost:4100/ |
| `Facility X is not one of <user>'s facilities` | The user has no access to that facility. Use one of the listed IDs, or another user |
| Header shows "(name not verified)" | The environment didn't return the facility list. Check the facility ID yourself |
| `not signed in` | The server restarted, or the session was idle for 8 hours. Log in again |
| Check setup: pick more dates | Too many cases for the picked days and rooms |
| `Room is double booked` | Another case already uses that room and time. Retry failed, or pick other days |
| Cases missing from Cases to Code | The facility has no active physician, or discharge failed. Check the case row |
| Charged cases missing from Patient Statements | The facility's statement settings exclude them (e.g. minimum balance). Raise the charge amount |
| Anesthesia Billing facility | Not supported. Clinical Seeder is for clinical facilities only |

Every failed case shows the step that failed and the server's own message. The full call log is in the run monitor.

---

## Status

- Tested end to end against a local mock of the API: all trackers, insurance, period/batch, retry, CSV and history.
- Live runs: start small (2 cases per tracker) on each new environment and check the trackers in the app before seeding in bulk.

---

## Contact

Owner: Ushali Chidipi. For bulk clinical data in any tracker, send the environment, facility and number of cases.

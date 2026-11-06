# Clinical Seeder

Bulk test data for **SIS Complete clinical (ASC) facilities**. It creates patients and cases through the web API and
takes each case to the tracker a test needs: **Scheduled → Performed (discharged) → Coded → Charged**. It also creates
**transaction codes**, **contracts** and **case flags**.

It runs on Node 22.6 or later and has no dependencies, so there is no build step.

```bash
git clone https://github.com/sis-uchidipi/Clinical-bulk-data-seeder.git
cd Clinical-bulk-data-seeder
npm install          # nothing to download; safe to skip
npm start            # → http://localhost:4100/
```

The [wiki](wiki/Home.md) has the setup steps, a walkthrough and troubleshooting.

Sign in with the environment's **API URL**, the **facility (organization) ID** and a user of that facility. Any
environment works: dev, QA, ditl, or a pipeline environment. The form starts with the dev environment's API URL and
facility **54 (Gem_Org022)**.

Sign-in checks the facility ID against the user's facilities (`User/UserOrgMap`). If the ID is not one of them, sign-in
stops and lists the facilities that user does have (e.g. `Gem_Org001 (40), Gem_Org022 (54), …`). The header then shows
the facility's name, so you always know where data is going.

## Pick the tracker, not the stage

Enter how many cases you want in each tracker. Each row shows the steps its cases go through and who pays:

| Tracker | Steps | Billing |
|---|---|---|
| Schedule Grid / Financial Clearance | Create case | the billing setting |
| Cases to Code | Create case → **Discharge** (status 4 → 10) | the billing setting |
| Charge Entry | … → Code (Ready to Charge, 11) | the billing setting |
| Insurance Billing | … → Charge entry (Ready for Bill, 12) | always insured (at least a primary) |
| **Patient Statements** | … → Charge entry (Ready for Bill, 12) | **always self pay** |

**Patient Statements.** A patient is listed there when a case is charged to Ready for Bill and the patient owes the
balance. The automation repo's Patient Statements test (TC#311412, Gem_Org022) starts from exactly that. So these
cases:

- get no insurance,
- have every procedure marked self pay (the Create Case "Self Pay: Yes" toggle),
- keep "no patient statement" off,
- and are charged into the run's period/batch.

The facility's own Patient Statements settings, such as a minimum balance, still apply.

One run can fill every tracker at once. Results, the run summary and the CSV are grouped by tracker.

### What you choose, and what is picked for you

- **You choose:** how many cases per tracker; the **dates of service** on the calendar (any days, today by default);
  how many **procedures per case**; and **insurance or no insurance** (Primary / + Secondary / + Tertiary). You can
  also limit the physicians, and set a tag, charge amount, diagnosis and period/batch.
- **Picked for you:**
  - **Rooms:** every active room in the facility, in turn. Cases are spread day by day, then room by room, then over
    15-minute slots from 07:00, so no two cases share a room at the same time. Check setup warns when the picked days
    don't have enough slots.
  - **Appointment type:** random for each case.
  - **Procedures:** random CPTs from the facility's fee schedule.

**Period & Batch** has its own tab, for creating open periods with a batch without creating any cases. A case run that
posts charges can also create one, or use an existing one.

### Clinical discharge

A clinical case reaches Cases to Code only when:

- `CaseSummary/UpdateCaseSatus` gets the bare status number as its body, and the case goes **4 (In Progress) and then
  10 (Performed)**. There is no direct Scheduled → Performed step.
- The case's primary physician is a physician of the facility. The Cases to Code tracker joins on it.

Clinical Seeder posts 4 and then 10, the same pair of status posts the automation repo's seeds use
(`playwright/app-modules-libs/sis-complete/shared/seed/case-charge-limit.seed.ts`). Room, appointment type, physician
and procedures always come from the facility's own lists, never from fixed ids.

## Features

- **Every step is checked.** A failed call stops that case, never the whole run. The case row shows the step and the
  server's own message, for example `Create case: … → 400: Room is double booked`.
- **Retry failed** re-runs only the failed cases, each from the step where it stopped. Patients and insurances that
  were already created are not created again.
- **Check setup** runs before anything is created. It confirms the facility has rooms, appointment types, physicians,
  fee-schedule CPTs and the chosen period/batch, and tells you what is missing.
- **CSV export** lists each case's name, DOB, patient ID, case ID, DOS, stage, physician, room, CPTs and insurances,
  ready to hand to manual testers.
- **Run history** is saved in `runs/`, which git ignores. You can reopen any run later.
- **The tag goes on everything.** It is added to patient last names, carriers, period/batch, transaction codes,
  contracts and flags, so every record traces back to its test case (e.g. `TC376164`).
- **Patient names can't collide.** Names are letters only and unique per run. The duplicate-patient check would
  otherwise attach a case to an existing patient.
- **Case flags are really created.** They are saved under the facility's Case Flagging lock (record lock type 27),
  with backoff while someone else holds the lock.
- **Safer by default.** The server listens on `127.0.0.1` only, and each browser has its own session (an HttpOnly
  cookie). The password is used once to sign in and never stored. Tokens never appear in logs or history.
- **Dates of service are picked on a calendar.** Cases are spread over the picked days and every room, in
  15-minute slots.

## API calls used

All paths are under `<API URL>/api/` and send the `token` and `ChartsApp` headers, as the web app does.

| Step | Calls |
|---|---|
| Sign in | `Login/LoginUser` → `UserSession/UserSessionOrg/{orgId}` |
| Lists | `Room/GetRoomsForOrganization`, `ApptypeCasepackMap/GetApptypeCasepackMapData`, `StaffList/GetStaffForOrganization/{org}/false`, `FeeSchedule/GetFeeSchedules/`, `PeriodBatch/GetPeriodBatch/false`, `facility/business/transaction-codes/general-ledger-accounts/is-active/false` |
| Patient | `PatientData/GetDuplicatePatients` (reserves the id) → `Security/RecordLock/RequestLock` → `PatientData/Gemini/GetPatient/{id}` → `PatientData/Gemini/CreatePatient/2030` → `ReleaseLock` |
| Insurance (once per run) | `InsuranceCarrierObject/SaveInsuranceCarrier` → `Insurance/InsertInsuranceClaimOffice` → `Insurance/UpdateInsuranceClaimOffice` → `InsurancePlan/SaveInsurancePlan` |
| Insurance (per patient) | `Insurance/Gemini/Insert/0` |
| Case | `CaseSummaryComplex/Gemini/UpsertCaseSummary` |
| Discharge | `CaseSummary/UpdateCaseSatus/{id}` with body `4`, then `10` |
| Code | `ScheduledCaseProcedure/GetScheduledProcedures/{id}/false`, `ICDCodeClassification/GetICDCodeClassifications`, `CaseToCode/SavePerformedItems`, status `11` |
| Charge | `PeriodConfig/UpsertCheckedPeriodObject` + `PeriodBatch/InsertBatch` (when creating), `CaseToCharge/SavePerformedProcedure/`, status `12` |
| Transaction codes | `POST facility/business/transaction-codes` |
| Contracts | `PUT facility/business/contracts` → posting option → `review-list/recalculate` |
| Case flags | `CaseFlag/Colors`, `CaseFlag/Config` under `RecordLock` type 27 |

The large request bodies (patient, case, charge entry and insurance) start from the request payloads in `templates/`.
Every environment-specific id in them (patient, physician, room, appointment type, fee schedule, carrier,
period/batch) is replaced at run time.

## Status

- Tested end to end against a local mock of the API. The mock enforces the contracts above: a bare-number status
  body, 4 before 10, a real physician, and a quoted ICD body. Tested so far: all four stages, insurance, period/batch
  creation, retry, CSV, history, and all three configuration modules.
- **Not yet run against a live environment.** The first live run should be small (e.g. 2 cases per stage). Check
  Cases to Code, Charge Entry and the ledger in the app before seeding in bulk.
- Clinical facilities only. Anesthesia Billing facilities have no discharge step, so they are not supported.

## Layout

```
src/server.ts          HTTP server and routes (UI + /api)
src/sis-client.ts      SIS API client: login, headers, retries, error messages, call log
src/lookups.ts         facility lists for the forms
src/runs.ts            run orchestration, pre-flight checks, retry, history, CSV
src/flows/case-flow.ts patient → case → discharge → code → charge
src/flows/insurance.ts carrier / claim office / plan, patient insurance
src/flows/period-batch.ts
src/flows/config-data.ts transaction codes, contracts, case flags
ui/                    single-page UI (no framework)
templates/             request payloads
wiki/                  the project wiki (setup, walkthrough, troubleshooting)
```

`npm run typecheck` runs the TypeScript compiler. It downloads TypeScript 5.6 through npx the first time.

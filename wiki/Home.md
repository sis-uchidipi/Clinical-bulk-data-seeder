# Clinical Seeder

Clinical Seeder creates bulk test data for **SIS Complete clinical (ASC) facilities**. It creates patients and cases
through the SIS web API and moves each case to the tracker a test needs:

**Schedule Grid → Cases to Code → Charge Entry → Insurance Billing / Patient Statements**

It also creates **periods and batches**, **transaction codes**, **contracts** and **case flags**.

## Pages

| Page | What it covers |
|---|---|
| [Clinical Seeder](Clinical-Seeder.md) | The full reference: features, architecture, endpoints, API calls, troubleshooting |
| [Setup](Setup.md) | Install, start, and sign in |
| [Walkthrough](Walkthrough.md) | Each tab, step by step, with what the app shows afterwards |
| [Trackers](Trackers.md) | Which steps and billing each tracker's cases get |
| [Troubleshooting](Troubleshooting.md) | Common errors and what to do |

## At a glance

- Runs locally on Node 22. No `npm install` and no build step.
- Works against any environment: dev, QA, ditl or a pipeline environment.
- Checks the facility ID against the signed-in user's facilities before creating anything.
- Every case row shows its tracker, IDs and status. Failed cases show the step and the server's message, and can be
  retried from where they stopped.
- Each run can be exported as CSV and is kept in `runs/` (ignored by git).
- Clinical facilities only. Anesthesia Billing facilities are not supported.

# Walkthrough

The left menu has two groups: **Cases** (Patients & Cases, Period & Batch) and **Runs** (History).

## Create cases

1. In **Patients & Cases**, enter a count for each tracker you need. Each row shows the steps its cases go through and who
   pays (see [Trackers](Trackers.md)).
2. Click the calendar icon in **Dates of service** and pick one or more days. Click **Done**. The field shows the
   picked dates.
3. Set **Procedures per case** and **Insurance**: no insurance (self pay), or Primary, Primary + Secondary, or
   Primary + Secondary + Tertiary.
4. Optional: a **tag** (for example `TC311412`), the physicians to use, the charge amount, the diagnosis code, and the
   period/batch (use an existing one or create one).
5. Click **Check setup**. It confirms the facility has rooms, appointment types, physicians, fee-schedule CPTs and the
   period/batch, and warns when the picked days don't have enough room slots.
6. Click **Create cases**. The run monitor shows each case with its tracker, patient, IDs and status.

When the run ends:

- **Retry failed** re-runs only the failed cases, each from the step where it stopped.
- **Download CSV** gives every case's name, DOB, patient ID, case ID, date of service, tracker, physician, room, CPTs
  and billing.

Then open the tracker in SIS Complete and search by the tag or a patient name from the CSV.

## Period & Batch

Creates open periods with a batch, without creating any cases.

## History

Lists every run, including runs from earlier sessions. Open one to see its cases, log and CSV.

## Tips

- Start small (2 cases per tracker) on a new environment, and check the trackers in the app before seeding in bulk.
- Use a tag on every run, so the data is easy to find and clean up later.

# Trackers

You choose how many cases you want in each tracker. The seeder takes each case through the steps that tracker needs.

| Tracker | Steps | Billing |
|---|---|---|
| Schedule Grid | Create case | Your insurance setting |
| Financial Clearance | Create case → **Discharge** (status 4, then 10) | Your insurance setting |
| Cases to Code | Create case → **Discharge** (status 4, then 10) | Your insurance setting |
| Charge Entry | … → Code (Ready to Charge, status 11) | Your insurance setting |
| Insurance Billing | … → Charge entry (Ready for Bill, status 12) | Always insured (at least a primary) |
| **Patient Statements** | … → Charge entry (Ready for Bill, status 12) | **Always self pay** |
| Revenue Cycle Management | … → Charge entry (Ready for Bill), RCM template days set to 0 | Your insurance setting |
| Remittance Posting | … → Charge entry → **ERA** (835 from the primary carrier) | Always insured (at least a primary) |

## Patient Statements

A patient is listed in the Patient Statements tracker when a case is charged to Ready for Bill and the patient owes the
balance. So Patient Statements cases:

- get no insurance,
- have every procedure marked self pay (the Create Case "Self Pay: Yes" toggle),
- keep "No patient statement" off,
- are charged into the run's period and batch.

The facility's own Patient Statements settings, such as a minimum balance, still apply.

## Remittance Posting

The Remittance Posting tracker lists **electronic remittances (835 ERAs)** that came in from a payer, and an ERA only
pays a patient who has insurance. By hand, a tester creates an insured patient and case, copies the patient's details
into an 835 file, and processes it in Postman. The seeder does exactly that for every Remittance Posting case:

1. creates the patient **with insurance** (the run's carrier as primary) and the case,
2. discharges, codes and charges it (Ready for Bill),
3. once the cases are charged, fills 835s with each patient's name, member id, date of service, CPTs and charges, the
   carrier as payer and the facility's tax id as payee, and posts them to the intake,
4. waits until the ERAs are in the tracker (up to 5 minutes) and marks each case **In tracker**.

For Remittance Posting the count is the number of **tracker records**, and **Patients per ERA** (under Case details,
1 to 10) is how many patients each record holds. Each record is one ERA (one check number) with one claim per patient in
`PaymentClaims`, so 2 records at 4 patients per ERA create 8 patients and 2 records. If a case fails before it is
charged, its record has fewer patients; Retry failed posts the retried cases in new ERAs.

Each claim carries the patient's **MRN** (the primary account number SIS gives the patient) as `SubmittersId` and
`Patient.Mrn`, as clearinghouse 835s do, so the intake can match every claim in the ERA to its patient.

Each ERA has:

- a numeric check/EFT number = the first case's ID + 4 digits (e.g. `123454821`), as the automation repo's ERAs use;
  every case in that ERA shows it in the results table and the CSV,
- payee = the facility and its federal tax id (FacilityConfiguration), which is how the intake finds the facility,
- one service line per charged CPT, split by the **ERA outcome** picked under Case details:

| ERA outcome | Claim status | Each charge is |
|---|---|---|
| Partial payment (default) | 1 processed | paid 80%, CO-45 write-off 10%, PR-2 coinsurance 10% |
| Paid in full | 1 processed | paid 100% |
| Applied to deductible | 1 processed | paid 0, PR-1 deductible 100% (the patient owes it) |
| Denied | 4 denied | paid 0, CO-50 (not medically necessary) 100% |
| Mix | — | rotates through the four, case by case |

  Paid plus adjustments always equals the charge to the cent. The results table and the CSV show each case's outcome.

The ERA goes to `ElectronicRemittanceIntake` the way the clearinghouse feed sends it. That call needs an Azure AD
app-to-app token, not your sign-in, so the seeder reads the app's values from the SIS automation repo cloned next to it, or from a local `.env` (see
[Setup](Setup.md#era-settings-remittance-posting-only)). Without either, the row says **Needs the ERA app values**.

The intake processes ERAs in a background job. The run keeps checking the facility tracker list (`BulkRemittanceDraft/GetRemittanceDraftList`) for up to 5 minutes
and shows "Waiting for N ERA(s)…" meanwhile; the Remittance Posting count and each case's status say how many arrived.
In the app, search the tracker by the payer (`Ins<tag>P`) or the check number.

## Revenue Cycle Management

The RCM tracker lists a charged account only once its **RCM template**'s "Days From Post/Transfer" have passed (14 by
default), so a new case would show two weeks later. Revenue Cycle Management cases are charged to Ready for Bill like
Insurance Billing / Patient Statements cases, and before they start the run sets the templates they fall under to
**0 days**, the way the automation repo's RCM tests do (Application Settings > Revenue Cycle Manager):

- insured cases: the template(s) covering the seeded carriers' classification, **Champus**,
- self-pay cases: **Self-Pay with No Insurance** and **Patient Responsibility**.

Templates already at 0 days are left alone. The run notes list what changed (e.g. `Self-Pay with No Insurance (14 → 0
days)`), and **Restore RCM template days** on the run (also from History) puts the old values back. After a restore,
the cases show again only once the restored days have passed.

If no template matches, or the sign-in may not change them, the run says so and the cases follow the facility's own
template days.

## Financial Clearance

The Financial Clearance tracker lists a case only after it is discharged, so Financial Clearance cases are created and
then discharged (status 4, then 10), the same steps as Cases to Code. A Schedule Grid case is not discharged, so it does
not show there.

The tracker also needs the patient's **email**. Every seeded patient gets one, `firstname.lastname@example.com`
(example.com is reserved, so nothing is ever delivered).

## What is picked for you

- **Rooms:** every active room of the facility, in turn. Cases are spread over the picked days, then the rooms, then
  15-minute slots from 07:00, so no two cases share a room at the same time.
- **Appointment type:** a random one for each case.
- **Procedures:** random CPTs from the facility's fee schedule. You choose how many per case.
- **Physician:** a random physician of the facility, unless you limit the list.

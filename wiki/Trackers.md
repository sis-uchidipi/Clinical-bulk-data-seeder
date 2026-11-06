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

## Patient Statements

A patient is listed in the Patient Statements tracker when a case is charged to Ready for Bill and the patient owes the
balance. So Patient Statements cases:

- get no insurance,
- have every procedure marked self pay (the Create Case "Self Pay: Yes" toggle),
- keep "No patient statement" off,
- are charged into the run's period and batch.

The facility's own Patient Statements settings, such as a minimum balance, still apply.

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

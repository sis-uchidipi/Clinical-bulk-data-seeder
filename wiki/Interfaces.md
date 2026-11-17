# Interfaces

Many test cases start with "send the … file through Postman": a 277 for a claim, an ADT message for a patient. The
**Interfaces** tab sends those messages for you, filled from the patients and cases this seeder created on the
signed-in facility, so names, MRNs, member IDs and dates of service always match. Each send is a run in **History**,
one row per message.

## 277 claim status

1. **Load seeded cases**: every case the seeder created on this environment and facility (all runs, newest first).
   By default only insured, charged cases are listed, since a 277 answers a billed claim.
2. Tick the cases, pick the **status** (STC01: A1 received, A2 accepted, A7 rejected, P1 pending, P2 payer review,
   F1 paid, F2 denied), and optionally the **Claim Status Remark** and, for a single case, the **ICN**.
3. **Send 277**.

Each message carries the case's primary carrier as payer, the patient's name, MRN and member ID, the DOS, a generated
ICN (Claim Tracking Number) and trace number (TRN); the run lists both per case. It goes to `ClaimStatusIntake` through
the gateway with the same app-to-app token as the ERAs (`SISSeedData.postClaimStatusIntakeRcm` in the automation repo).

The claim status process runs in the background, so it can take a few minutes to show in the case's **Claim Status
History** (Facesheet > Transactions) and the **RCM tracker**'s Insurance tab (TC 377201, 377551).

## Inbound ADT patients

Sends new patients the way an ADT feed does: demographics with a random 8-digit **external MRN**, and a primary
insurance when ticked (carrier `Ins<tag>ADT`). It goes to `InboundADTPatient/UpsertPatient` with your session, every
text value base64-encoded (the automation repo's Cypress ADT seeds, TC 286291 / 286292).

Before sending:

- **Inbound ADT** must be on for the facility (Enterprise > Facility Management > Internal).
- The **data source identifier** must be registered on the enterprise. The field starts with the one the automation
  tests use.

Find the patients by external MRN (Failed Import Manager, or patient search) or by the run tag in their last names.

## Not here yet

- **PRP patient payment remittances**: they go through the EDI parse service with a second Azure app first.
- **SIS Exchange case requests**: they need a Gateway login with a user's password, which the seeder never keeps.

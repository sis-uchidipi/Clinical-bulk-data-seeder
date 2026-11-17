import type { SisClient } from '../sis-client.ts';
import { ApiError } from '../sis-client.ts';
import { firstString, template } from '../util.ts';

/**
 * The Azure AD app the gateway accepts for ElectronicRemittanceIntake (an app-to-app client-credentials token, not the
 * user's session). The values are secrets: they come from the environment, the git-ignored `.env`, or the automation
 * repo checkout on this machine (era-settings.ts), never from this repository's code.
 */
const ERA_ENV = ['SIS_ERA_TENANT_ID', 'SIS_ERA_CLIENT_ID', 'SIS_ERA_CLIENT_SECRET'] as const;

/** One charged procedure the ERA pays: the CPT and the amount it was charged at. */
export type RemittedCharge = { cptCode: string; amount: number };

/**
 * One ERA (one Remittance Posting tracker row, under its check number) from one payer, paying one claim per patient.
 */
export type Remittance = {
    checkNumber: string;
    payerName: string;
    claims: RemittanceClaim[];
};

/** One patient's claim in an ERA. */
export type RemittanceClaim = {
    patientId: number;
    /** The patient's MRN (primary account number). The intake matches each claim to its patient by it. */
    mrn: string;
    firstName: string;
    lastName: string;
    /** The patient's member id on the primary insurance (835 NM1*QC MI), as entered on the patient's insurance. */
    memberId: string;
    /** mm/dd/yyyy, as the case stores it. */
    dateOfService: string;
    charges: RemittedCharge[];
    outcome: EraOutcome;
};

/** Names of the ERA settings that are not set, so Check setup can say what to add to `.env`. */
export function missingEraSettings(): string[] {
    return ERA_ENV.filter((key) => !process.env[key]?.trim());
}

/** Asks Azure AD for the app token once, so `npm run setup` can say whether the values work. Throws if they don't. */
export async function verifyEraSettings(): Promise<void> {
    cachedToken = undefined;
    await appToken();
}

/**
 * Posts one 835 ERA for one or more charged cases, the way the clearinghouse feed does: the parsed ERA (base64 JSON)
 * goes to ElectronicRemittanceIntake with an app-to-app token and the facility id. The Remittance Posting tracker then
 * lists it as one row under the payer and check number, with one claim per patient, once the intake job has run.
 */
export async function postRemittance(client: SisClient, remittance: Remittance): Promise<void> {
    if (!remittance.claims.length) throw new Error('an ERA needs at least one claim');
    const facility = await facilityDetails(client);
    const era = eraPayload(remittance, facility);
    const encoded = Buffer.from(JSON.stringify(era)).toString('base64');
    await gatewayPost(client, 'ElectronicRemittanceIntake', {
        RawEdiString: encoded,
        ParsedEdiString: encoded,
        FileName: ERA_FILE_NAME,
    });
}

/**
 * base64 "FileName", exactly what the automation repo's ERAs send. The intake answers 200 to any name, but its job
 * reads the file type from the extension (PRP files are sent as `….prp`): a `.835` name was accepted and never reached
 * the tracker.
 */
const ERA_FILE_NAME = Buffer.from('FileName').toString('base64');

/**
 * An inbound EDI message as the clearinghouse feed sends it: the gateway's app-to-app token (not the user's session),
 * application_identifier Gateway, and the facility in sis-organization-id. ERAs (ElectronicRemittanceIntake) and claim
 * status (ClaimStatusIntake) both go this way.
 */
export async function gatewayPost(client: SisClient, path: string, body: unknown): Promise<any> {
    const token = await appToken();
    return client.post(path, body, {
        anonymous: true,
        headers: { Authorization: `Bearer ${token}`, application_identifier: 'Gateway', 'sis-organization-id': String(client.session.organizationId) },
        retries: 1,
    });
}

/**
 * The check numbers among `checkNumbers` that the Remittance Posting tracker already shows for this facility. The
 * intake processes ERAs in a background job, so callers ask again until every one is there. A facility sign-in reads
 * the facility tracker's list (BulkRemittanceDraft/GetRemittanceDraftList, which the automation repo polls); the CBO
 * list answers it 403 "Invalid CBO Entity ID" and is only tried when the facility list can't be read. Rows are matched
 * on the check number anywhere in the row.
 */
export async function remittancesInTracker(client: SisClient, checkNumbers: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    const match = (rows: any[]) => {
        for (const row of rows) {
            const text = JSON.stringify(row);
            for (const check of checkNumbers) if (text.includes(check)) found.add(check);
        }
    };
    try {
        const answer: any = await client.get('BulkRemittanceDraft/GetRemittanceDraftList', { retries: 1 });
        match(Array.isArray(answer) ? answer : answer?.result ?? answer?.data ?? answer?.items ?? []);
        return found;
    } catch (err) {
        if (!(err instanceof ApiError) || (err.status !== 403 && err.status !== 404)) throw err;
    }
    for (let page = 1; page <= 20 && found.size < checkNumbers.length; page += 1) {
        const answer: any = await client.post('CBO/RemittancePosting/List', { cBOEntityId: -1, facilityIds: [client.session.organizationId], pageNumber: page, rowsPerPage: 500 }, { retries: 1 });
        const rows: any[] = answer?.cboRemittancePosting ?? [];
        match(rows);
        if (rows.length < 500) break;
    }
    return found;
}

/**
 * What the payer did with the claim, as the 835 says it: how much it paid and which adjustment (group + CARC reason)
 * takes the rest. Each share is a fraction of the charge; the last one takes the rounding.
 */
export const ERA_OUTCOMES = {
    partial: { label: 'Partial payment', claimStatus: '1', paid: 0.8, adjustments: [['CO', '45', 0.1], ['PR', '2', 0.1]] },
    full: { label: 'Paid in full', claimStatus: '1', paid: 1, adjustments: [] },
    deductible: { label: 'Applied to deductible', claimStatus: '1', paid: 0, adjustments: [['PR', '1', 1]] },
    denied: { label: 'Denied (CO-50)', claimStatus: '4', paid: 0, adjustments: [['CO', '50', 1]] },
} as const satisfies Record<string, { label: string; claimStatus: string; paid: number; adjustments: readonly (readonly [string, string, number])[] }>;
export type EraOutcome = keyof typeof ERA_OUTCOMES;

type Line = { paid: number; adjustments: { group: string; reason: string; amount: number }[] };

/** Splits one charge in cents so paid + adjustments always add up to the charge exactly. */
function split(amount: number, outcome: EraOutcome): Line {
    const rule = ERA_OUTCOMES[outcome];
    const cents = Math.round(amount * 100);
    const paid = Math.round(cents * rule.paid);
    let left = cents - paid;
    const adjustments = rule.adjustments.map(([group, reason, share], i, all) => {
        const part = i === all.length - 1 ? left : Math.min(left, Math.round(cents * share));
        left -= part;
        return { group, reason, amount: part / 100 };
    }).filter((a) => a.amount > 0);
    return { paid: paid / 100, adjustments };
}

const cents = (amount: number) => Math.round(amount * 100);

function eraPayload(remittance: Remittance, facility: FacilityDetails): any {
    const era = template('electronicRemittance835.json');
    const model = era.EdiModel;
    const dataSet = model.ClaimRemittanceDataSets[0];
    const claimBase = dataSet.PaymentClaims[0];
    const today = new Date();
    dataSet.PaymentClaims = remittance.claims.map((claim) => paymentClaim(claimBase, claim, facility, remittance.checkNumber));
    const totalPaid = dataSet.PaymentClaims.reduce((sum: number, c: any) => sum + cents(c.PaymentAmount), 0) / 100;

    Object.assign(model, {
        PaymentDate: `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`,
        CheckOrEftNumber: remittance.checkNumber,
        TotalPaymentAmount: totalPaid,
    });
    model.Payer.Name = remittance.payerName;
    Object.assign(model.Payee, { Name: facility.name, IdentificationCode: facility.taxId, FederalTaxId: facility.taxId });
    return era;
}

/** One CLP loop: the patient, their charges split by the outcome, and the claim totals. */
function paymentClaim(base: any, claim: RemittanceClaim, facility: FacilityDetails, checkNumber: string): any {
    const paymentClaim = structuredClone(base);
    const paymentBase = paymentClaim.Payments[0];
    const adjustmentBase = paymentBase.PaymentAdjustments[0];
    let patientCents = 0;
    const payments = claim.charges.map((charge) => {
        const { paid, adjustments } = split(charge.amount, claim.outcome);
        const payment = structuredClone(paymentBase);
        payment.Procedures[0].ProcedureCode = charge.cptCode;
        payment.ChargeAmount = charge.amount;
        payment.PaymentAmount = paid;
        payment.CaseDateOfServices = [claim.dateOfService];
        payment.PaymentAdjustments = adjustments.map((a) => ({
            ...structuredClone(adjustmentBase),
            AdjustmentGroupCode: a.group,
            Adjustments: [{ ...adjustmentBase.Adjustments[0], ReasonCode: a.reason, Amount: a.amount }],
        }));
        patientCents += adjustments.filter((a) => a.group === 'PR').reduce((sum, a) => sum + Math.round(a.amount * 100), 0);
        return payment;
    });
    const total = (key: 'ChargeAmount' | 'PaymentAmount') => payments.reduce((sum: number, p: any) => sum + cents(p[key]), 0) / 100;
    const patientTotal = patientCents / 100;

    Object.assign(paymentClaim, {
        StatusCode: ERA_OUTCOMES[claim.outcome].claimStatus,
        // The patient's MRN, as the clearinghouse 835s carry it (CLP01 / NM1*QC).
        SubmittersId: claim.mrn,
        // The payer's claim number: unique per claim in the ERA.
        ReferenceId: `${checkNumber}${String(claim.patientId).slice(-4)}`,
        ChargeAmount: total('ChargeAmount'),
        PaymentAmount: total('PaymentAmount'),
        PatientResponsibilityAmount: patientTotal,
        CaseDateOfService: claim.dateOfService,
        Payments: payments,
    });
    paymentClaim.ServiceProvider.LastName = facility.name;
    Object.assign(paymentClaim.Patient, { FirstName: claim.firstName, LastName: claim.lastName, IdentificationCode: claim.memberId, Mrn: claim.mrn });
    return paymentClaim;
}

// #region Facility and token

type FacilityDetails = { name: string; taxId: string };

const facilityCache = new Map<string, Promise<FacilityDetails>>();

/**
 * The payee of the ERA. The intake refuses an ERA whose payee federal tax id is not the facility's (400 "FederalTaxId").
 * FacilityConfiguration/GetFacilityDetails answers only to an Enterprise session (403 "Session not connected to
 * Enterprise" from a facility one), which is how the automation repo reads it. So the session is moved to the facility's
 * enterprise for that one read and back to the facility, as the app does when opening Enterprise Configuration. Call it
 * once per run before any case work: switching the session while other calls are in flight would misroute them.
 */
function facilityDetails(client: SisClient): Promise<FacilityDetails> {
    const { apiUrl, organizationId, organizationName } = client.session;
    const key = `${apiUrl}|${organizationId}`;
    if (!facilityCache.has(key)) {
        facilityCache.set(key, readFacilityDetails(client).then((details) => {
            const taxId = firstString(details?.taxId, details?.federalTaxId, details?.TaxId);
            if (!taxId) throw new Error(`facility ${organizationId} has no federal tax id in Facility Configuration; the intake needs it to accept an ERA`);
            return { name: firstString(details?.name, details?.facilityName, details?.organizationName, organizationName) ?? `Facility ${organizationId}`, taxId };
        }));
        // A failure stays cached for the run: the cases must not each switch the session in parallel. Runs and retries
        // start with prepareFacilityDetails, which asks again.
        facilityCache.get(key)!.catch(() => undefined);
    }
    return facilityCache.get(key)!;
}

/** Reads the facility's payee details afresh, before a run's cases start (nothing else is using the session then). */
export function prepareFacilityDetails(client: SisClient): Promise<FacilityDetails> {
    facilityCache.delete(`${client.session.apiUrl}|${client.session.organizationId}`);
    return facilityDetails(client);
}

async function readFacilityDetails(client: SisClient): Promise<any> {
    const { organizationId } = client.session;
    const path = `FacilityConfiguration/GetFacilityDetails/${organizationId}`;
    try {
        return await client.get(path, { retries: 0 });
    } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 403) throw err;
    }
    return client.asEnterprise(() => client.get(path, { retries: 0 }));
}

let cachedToken: { value: string; expires: number } | undefined;

/** Client-credentials token for the gateway, reused until a minute before it expires. Never logged. */
async function appToken(): Promise<string> {
    if (cachedToken && cachedToken.expires > Date.now()) return cachedToken.value;
    const missing = missingEraSettings();
    if (missing.length) throw new Error(`ERA settings missing: set ${missing.join(', ')} in .env (see wiki/Setup.md)`);
    const [tenant, clientId, secret] = ERA_ENV.map((key) => process.env[key]!.trim());
    const response = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, scope: `api://${clientId}/.default` }),
        signal: AbortSignal.timeout(30_000),
    });
    const body: any = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
        throw new ApiError('POST', 'ERA app token', response.status, firstString(body.error_description?.split('\r\n')[0], body.error) ?? '');
    }
    cachedToken = { value: body.access_token, expires: Date.now() + (Number(body.expires_in) || 3600) * 1000 - 60_000 };
    return cachedToken.value;
}

// #endregion

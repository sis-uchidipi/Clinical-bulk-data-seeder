import { randomInt } from 'node:crypto';

import type { SisClient } from '../sis-client.ts';
import { pick, template } from '../util.ts';
import { gatewayPost } from './remittance.ts';

/**
 * Inbound interface messages, filled from a seeded patient or case instead of being hand-edited in Postman, through the
 * same calls the automation repo makes:
 * - 277 claim status (SISSeedData.postClaimStatusIntakeRcm): parsed 277 JSON, base64, to ClaimStatusIntake through the
 *   gateway with the app-to-app token. It lands in the case's Claim Status History and the RCM tracker.
 * - Inbound ADT (TransactionalApis.inboundAdtUpsertPatient, the Cypress encoding): patient JSON with every string value
 *   base64-encoded, to InboundADTPatient/UpsertPatient with the user's session. It lands in Failed Import Manager or
 *   updates / creates the patient, per the facility's ADT settings.
 */

// #region 277 claim status

/** The STC01 category the payer answers with; the RCM tracker shows it as "<code>; <description>". */
export const CLAIM_STATUS_CATEGORIES = {
    A1: 'Acknowledged: received',
    A2: 'Acknowledged: accepted into adjudication',
    A7: 'Acknowledged: rejected (invalid information)',
    P1: 'Pending: in process',
    P2: 'Pending: payer review',
    F1: 'Finalized: payment',
    F2: 'Finalized: denial',
} as const;
export type ClaimStatusCategory = keyof typeof CLAIM_STATUS_CATEGORIES;

export type ClaimStatusCase = {
    patientId: number;
    caseSummaryId: number;
    firstName: string;
    lastName: string;
    /** yyyy-mm-dd, as the seeder keeps it. */
    dateOfService: string;
    memberId?: string;
    /** The payer: the carrier name of the case's primary insurance. */
    payerName: string;
};

export type ClaimStatusOptions = {
    category: ClaimStatusCategory;
    /** Payer claim control number, shown as "Claim Tracking Number" (the ICN). Generated when blank. */
    icn?: string;
    /** Free-form text, shown as "Claim Status Remark". */
    remark?: string;
};

/** The 277 for one case; returns the ICN and trace number it carries, so the tester can find it in the app. */
export async function sendClaimStatus(client: SisClient, c: ClaimStatusCase, options: ClaimStatusOptions): Promise<{ icn: string; trace: string }> {
    const icn = options.icn?.trim() || `ICN${c.caseSummaryId}${randomInt(1000, 10000)}`;
    const trace = `TRN${c.caseSummaryId}${randomInt(1000, 10000)}`;
    const now = new Date().toISOString().slice(0, 19);
    const message = template('claimStatus277.json');
    const model = message.EdiModel;
    model.ClaimStatusResponseDate = now;
    const perPayer = model.ClaimsPerPayer[0];
    perPayer.Payer.Name = c.payerName;
    const provider = perPayer.InformationReceiverList[0].ServiceProviderList[0];
    provider.ServiceProviderInformation.LastName = client.session.organizationName ?? `Facility ${client.session.organizationId}`;
    const subscriber = provider.SubscriberList[0];
    Object.assign(subscriber.EntityInformation, { LastName: c.lastName, FirstName: c.firstName, IdentificationCode: c.memberId ?? String(c.patientId), Mrn: String(c.patientId) });
    const caseInfo = subscriber.CaseInformationList[0];
    Object.assign(caseInfo, { ClaimTrackingNumber: trace, PayerClaimControlNumber: icn, DateOfService: `${c.dateOfService}T00:00:00` });
    Object.assign(caseInfo.CaseLevelStatusInformationList[0], {
        StatusEffectiveDate: now,
        FreeFormMessageText: options.remark?.trim() || `${options.category} ${CLAIM_STATUS_CATEGORIES[options.category]}`,
    });
    caseInfo.CaseLevelStatusInformationList[0].Status_STC01.ClaimStatusCategoryCode = options.category;
    message.Errors.ControlNumber = String(randomInt(1, 10000)).padStart(4, '0');
    await gatewayPost(client, 'ClaimStatusIntake', { ParsedEdiString: Buffer.from(JSON.stringify(message)).toString('base64') });
    return { icn, trace };
}

// #endregion

// #region Inbound ADT

/** The data source the automation repo's ADT tests send from; it must be registered on the enterprise. */
export const DEFAULT_ADT_SOURCE = '1da15f4d-3a7c-4a67-b5eb-4cff2d0cc45b';

export type AdtPatient = { firstName: string; lastName: string; dob: string; externalMRN: string };
export type AdtOptions = { sourceIdentifier?: string; insuranceCarrier?: string };

const STREETS = ['Main St', 'Oak Ave', 'Pine Rd', 'Maple Dr', 'Cedar Ln'];

/** One patient as an ADT feed sends it (A04/A08 equivalent): demographics, and a primary insurance when asked. */
export async function sendAdtPatient(client: SisClient, patient: AdtPatient, options: AdtOptions): Promise<void> {
    const address = { addressLine1: `${randomInt(10, 999)} ${pick(STREETS)}`, addressLine2: '', city: 'Nashville', state: 'TN', zip: '37203', county: null, country: 'US' };
    const phone = { number: `615${randomInt(1000000, 9999999)}`, isCell: true, isPrimaryContact: true };
    const insurances = options.insuranceCarrier ? [{
        Insurance: null, InsuranceCompanyName: options.insuranceCarrier,
        InsuranceCompanyAddress: { AddressLine1: 'PO Box 100', City: 'Nashville', State: 'TN', Zip: '37203', Country: 'US' },
        RelationshipToSubscriber: 'Self', LastName: patient.lastName, FirstName: patient.firstName, MI: '', Suffix: '', Sex: 'Male', DOB: patient.dob,
        Address: address, PrimaryPhone: { Number: phone.number, IsCell: true, IsPrimaryContact: true },
        SubscriberID: `MB${patient.externalMRN}`, GroupName: 'Seeder Group', GroupNumber: 'G100', Employer: '', EffectiveDate: '01-01-2025', EffectiveTo: '', SortOrder: 1,
    }] : [];
    const body = {
        externalSourceIdentifier: options.sourceIdentifier?.trim() || DEFAULT_ADT_SOURCE,
        patient: {
            externalMRN: patient.externalMRN, firstName: patient.firstName, lastName: patient.lastName, middle: '', suffix: '',
            dob: patient.dob, ssn: '', gender: 'Male', race: '', primaryLanguage: '', nickName: '', maritalStatus: '', ethnicity: 'Declined',
            religion: '', occupation: '', email: `${patient.firstName}.${patient.lastName}@example.com`.toLowerCase(),
            address, primaryPhone: phone, secondaryPhone: { number: '', isCell: false, isPrimaryContact: false },
            insurances, guarantors: [], DeceasedTf: false, DeceasedDate: '',
        },
    };
    await client.post('InboundADTPatient/UpsertPatient', encodeStrings(body), { retries: 0 });
}

/** The ADT endpoint takes every string value base64-encoded (SISSeedData.encodeValues in the Cypress seeds). */
function encodeStrings(value: any): any {
    if (typeof value === 'string') return Buffer.from(value).toString('base64');
    if (Array.isArray(value)) return value.map(encodeStrings);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeStrings(v)]));
    return value;
}

/** A random, never-reused external MRN (8 digits, as TC 286291 uses). */
export function externalMrn(): string {
    return String(randomInt(10_000_000, 100_000_000));
}

// #endregion

import type { SisClient } from '../sis-client.ts';
import { firstNumber, firstString, template } from '../util.ts';

/** One carrier with its claim office and plan, created once per run and attached to every patient of that run. */
export type CarrierSetup = {
    carrierId: number;
    carrierName: string;
    planId: number;
    planName: string;
    claimOfficeId: number;
};

/** What Insurance/Gemini/Insert answers for a patient: the patient insurance the case and charges point to. */
export type PatientInsurance = {
    patientInsuranceId: number;
    displayName: string;
    raw: any;
};

/**
 * Carrier → claim office (insert, then update to finish it) → plan, the same four saves the Insurance Carriers screen
 * does. Throws with the failing step named, since a half-built carrier is useless to the cases.
 */
export async function createCarrier(client: SisClient, name: string): Promise<CarrierSetup> {
    const carrierPayload = template('saveInsuranceCarrier.json');
    carrierPayload.insuranceCarrierName = name;
    if (carrierPayload.insurancePlanSaveDetails) carrierPayload.insurancePlanSaveDetails.planName = `${name} Plan`;
    const carrier = await step('save carrier', () => client.put('InsuranceCarrierObject/SaveInsuranceCarrier', carrierPayload));
    const carrierId = firstNumber(carrier?.insuranceCarrierId, carrier?.insuranceCarrierObjectId);
    if (!carrierId) throw new Error(`save carrier: no carrier id in the answer for ${name}`);

    const officePayload = { ...template('insertInsuranceClaimOffice.json'), insuranceCarrierObjectId: carrierId };
    const office = await step('insert claim office', () => client.post('Insurance/InsertInsuranceClaimOffice', officePayload));
    const claimOfficeId = firstNumber(office?.claimOfficeId, office?.insuranceClaimOfficeId);
    if (!claimOfficeId) throw new Error(`insert claim office: no claim office id for ${name}`);
    await step('update claim office', () => client.post('Insurance/UpdateInsuranceClaimOffice', { ...template('updateInsuranceClaimOffice.json'), insuranceCarrierObjectId: carrierId, claimOfficeId }));

    const planId = firstNumber(carrier?.insurancePlanSaveDetails?.insurancePlanId);
    const planName = firstString(carrier?.insurancePlanSaveDetails?.planName, carrierPayload.insurancePlanSaveDetails?.planName) ?? `${name} Plan`;
    const plan = await step('save plan', () => client.put('InsurancePlan/SaveInsurancePlan', { ...template('saveInsurancePlan.json'), insuranceCarrierId: carrierId, claimOfficeId, insurancePlanId: planId ?? 0, planName }));
    const savedPlanId = firstNumber(plan?.insurancePlanId, planId);
    if (!savedPlanId) throw new Error(`save plan: no plan id for ${name}`);
    return { carrierId, carrierName: name, planId: savedPlanId, planName, claimOfficeId };
}

/** Adds the carrier's plan to the patient's insurances (the Billing Details "add insurance" save). */
export async function addPatientInsurance(client: SisClient, patient: { patientId: number; firstName: string; lastName: string }, carrier: CarrierSetup): Promise<PatientInsurance> {
    const payload = template('insertInsurance.json');
    Object.assign(payload, {
        patientId: patient.patientId,
        firstName: patient.firstName,
        lastName: patient.lastName,
        insuranceCarrierId: carrier.carrierId,
        carrier: carrier.carrierName,
        insuranceId: String(carrier.planId),
        planName: carrier.planName,
        insuranceClaimOfficeId: carrier.claimOfficeId,
        displayName: `${carrier.carrierName}, ${carrier.planName}`,
    });
    const saved = await client.post('Insurance/Gemini/Insert/0', payload, { contentType: 'text/json' });
    const patientInsuranceId = firstNumber(saved?.patientInsuranceId, saved?.PatientInsuranceId);
    if (!patientInsuranceId) throw new Error(`add insurance ${carrier.carrierName}: the answer had no patientInsuranceId`);
    return { patientInsuranceId, displayName: firstString(saved?.displayName) ?? payload.displayName, raw: saved };
}

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (err) {
        throw new Error(`${name}: ${(err as Error).message}`);
    }
}

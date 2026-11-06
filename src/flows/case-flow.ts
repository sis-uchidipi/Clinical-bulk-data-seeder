import type { FeeScheduleItem, Option } from '../lookups.ts';
import type { SisClient } from '../sis-client.ts';
import type { CarrierSetup, PatientInsurance } from './insurance.ts';
import type { PeriodBatch } from './period-batch.ts';
import { addPatientInsurance } from './insurance.ts';
import { caseSlot, errorMessage, firstNumber, firstString, pick, sleep, template, ZERO_GUID } from '../util.ts';

/** How far a case is taken. Each stage is where the case shows up for testing. */
export const STAGES = ['scheduled', 'performed', 'coded', 'charged'] as const;
export type Stage = (typeof STAGES)[number];

/**
 * The trackers a run can fill. Each one is a stage plus who owes the balance: a charged case lands in Insurance Billing
 * when an insurance carries it, and in Patient Statements when the patient owes it (self pay, Ready for Bill).
 */
export const TRACKERS = [
    { id: 'scheduleGrid', label: 'Schedule Grid', stage: 'scheduled', billing: 'either', shows: 'Scheduled cases for the schedule grid and check-in.' },
    { id: 'financialClearance', label: 'Financial Clearance', stage: 'performed', billing: 'either', shows: 'Discharged (Performed) cases. Financial Clearance lists a case only after discharge.' },
    { id: 'casesToCode', label: 'Cases to Code', stage: 'performed', billing: 'either', shows: 'Discharged (Performed) cases waiting to be coded.' },
    { id: 'chargeEntry', label: 'Charge Entry', stage: 'coded', billing: 'either', shows: 'Coded cases, Ready to Charge.' },
    { id: 'insuranceBilling', label: 'Insurance Billing', stage: 'charged', billing: 'insured', shows: 'Charges posted, Ready for Bill, billed to the patient\'s insurance.' },
    { id: 'patientStatements', label: 'Patient Statements', stage: 'charged', billing: 'selfPay', shows: 'Charges posted, Ready for Bill, self pay: the patient owes the balance.' },
] as const;
export type TrackerId = (typeof TRACKERS)[number]['id'];

/**
 * CaseStatusEnum numbers the web app posts to CaseSummary/UpdateCaseSatus. A scheduled case cannot jump straight to
 * Performed: the nursing discharge goes In Progress (4) → Performed (10) (see case-charge-limit.seed.ts in the
 * automation repo). 11 / 12 are what Coding (Ready to Charge) and Charge Entry (Ready for Bill) post.
 */
const CASE_STATUS = { inProgress: 4, performed: 10, readyToCharge: 11, readyForBill: 12 } as const;

export type StepResult = { name: string; ok: boolean; ms: number; error?: string };

export type CaseRecord = {
    index: number;
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    dateOfService: string;
    /** Which of the facility's rooms (round robin over all of them) and which 15-minute slot of the day. */
    roomIndex: number;
    slot: number;
    /** The tracker this case is made for; `target` is the stage that puts it there. */
    tracker: TrackerId;
    target: Stage;
    /** No insurance: the patient owes the balance (needed for Patient Statements). */
    selfPay: boolean;
    /** The last stage this case completed; null until the case itself exists. */
    reached: Stage | 'patient' | null;
    patientId?: number;
    caseSummaryId?: number;
    patientInsurances: PatientInsurance[];
    physician?: string;
    room?: string;
    cptCodes: string[];
    steps: StepResult[];
    error?: string;
    /** Working data a retry needs (kept server-side, never sent to the browser). */
    savedPatient?: any;
    performedItems?: any[];
};

/** What every case of a run shares: the session and the picks the user made (empty list = random from the facility). */
export type CaseContext = {
    client: SisClient;
    rooms: Option[];
    appointmentTypes: Option[];
    physicians: Option[];
    procedures: FeeScheduleItem[];
    /** How many procedures each case gets, picked at random from `procedures` when more are offered. */
    proceduresPerCase: number;
    amounts: Record<string, number>;
    carriers: CarrierSetup[];
    periodBatch?: PeriodBatch;
    diagnosisCode: string;
};

const stageRank = (stage: CaseRecord['reached']) => (stage === null ? -2 : stage === 'patient' ? -1 : STAGES.indexOf(stage));

/**
 * Takes one case from wherever it stopped up to its target stage. Every API answer is checked; the first failure stops
 * this case (never the run) and is kept on the record with the server's message, so a retry resumes from that step.
 */
export async function advanceCase(ctx: CaseContext, rec: CaseRecord): Promise<void> {
    rec.error = undefined;
    const target = STAGES.indexOf(rec.target);
    try {
        if (stageRank(rec.reached) < -1) {
            await timed(rec, 'Create patient', () => createPatient(ctx, rec));
            rec.reached = 'patient';
        }
        if (stageRank(rec.reached) < 0) {
            if (!rec.selfPay && ctx.carriers.length && rec.patientInsurances.length < ctx.carriers.length) {
                await timed(rec, 'Add insurance', () => addInsurances(ctx, rec));
            }
            await timed(rec, 'Create case', () => createCase(ctx, rec));
            rec.reached = 'scheduled';
        }
        if (target >= 1 && stageRank(rec.reached) < 1) {
            await timed(rec, 'Discharge', () => discharge(ctx, rec));
            rec.reached = 'performed';
        }
        if (target >= 2 && stageRank(rec.reached) < 2) {
            await timed(rec, 'Code (Cases to Code)', () => code(ctx, rec));
            rec.reached = 'coded';
        }
        if (target >= 3 && stageRank(rec.reached) < 3) {
            await timed(rec, 'Charge Entry', () => charge(ctx, rec));
            rec.reached = 'charged';
        }
    } catch (err) {
        rec.error = errorMessage(err);
    }
}

async function timed(rec: CaseRecord, name: string, run: () => Promise<void>): Promise<void> {
    const started = Date.now();
    try {
        await run();
        rec.steps.push({ name, ok: true, ms: Date.now() - started });
    } catch (err) {
        rec.steps.push({ name, ok: false, ms: Date.now() - started, error: errorMessage(err) });
        throw new Error(`${name}: ${errorMessage(err)}`);
    }
}

// #region Patient

/**
 * GetDuplicatePatients reserves a new patient id when nothing matches (an entry with no name); CreatePatient then saves
 * the patient under it while the patient record lock is held, as the Create a Case wizard does.
 */
async function createPatient(ctx: CaseContext, rec: CaseRecord): Promise<void> {
    const search = { ...template('getDuplicatePatients.req.json'), firstName: rec.firstName, lastName: rec.lastName, dateOfBirth: rec.dateOfBirth };
    const matches: any[] = await ctx.client.post('PatientData/GetDuplicatePatients', search, { contentType: 'text/json' });
    const reserved = (Array.isArray(matches) ? matches : []).find((m) => m?.patientId && !m.firstName && !m.lastName);
    if (!reserved) throw new Error(`a patient named ${rec.firstName} ${rec.lastName} already exists; no new patient id was reserved`);
    const patientId = Number(reserved.patientId);
    const lock = { patientId, recordLockTypeId: 13, objectId: patientId, moduleId: 2030 };

    await ctx.client.post('Security/RecordLock/RequestLock', lock, { contentType: 'text/json' });
    try {
        const current = await ctx.client.get(`PatientData/Gemini/GetPatient/${patientId}`);
        const payload = patientPayload(template('createPatient.req.json'), current, rec, patientId);
        const saved = await ctx.client.post('PatientData/Gemini/CreatePatient/2030', payload, { contentType: 'text/json', timeoutMs: 180_000 });
        rec.patientId = firstNumber(saved?.patientId, patientId);
        rec.savedPatient = saved && typeof saved === 'object' ? saved : payload;
    } finally {
        await ctx.client.post('Security/RecordLock/ReleaseLock', lock, { contentType: 'text/json', retries: 0 }).catch(() => undefined);
    }
}

function patientPayload(payload: any, current: any, rec: CaseRecord, patientId: number): any {
    const accounts = Array.isArray(current?.accountNumbers) ? current.accountNumbers : [];
    Object.assign(payload, {
        patientId,
        firstName: rec.firstName,
        lastName: rec.lastName,
        middleInitial: '',
        title: '',
        dateOfBirth: rec.dateOfBirth,
        gender: pick(['Male', 'Female']),
        email: patientEmail(rec),
        fullName: `${rec.firstName} ${rec.lastName}`,
        fullNameWithTitle: `${rec.firstName} ${rec.lastName}`,
        fullNameWithTitlePrefixAsLastName: `${rec.lastName} ${rec.firstName}`,
        externalId: current?.externalId ?? patientId,
        sourceIdentifier: current?.sourceIdentifier ?? payload.sourceIdentifier,
        primaryAccountNumber: current?.primaryAccountNumber ?? null,
    });
    if (Array.isArray(payload.accountNumbers)) {
        payload.accountNumbers = payload.accountNumbers.map((entry: any, i: number) => ({ ...entry, ...(accounts[i] ?? accounts[0] ?? {}), patientId }));
    }
    for (const phone of [payload.mpiPatientPhone, payload.mpiPatientPhoneSecondary]) {
        if (phone) phone.patientId = patientId;
    }
    return payload;
}

/** Financial Clearance needs the patient's email. example.com is reserved, so nothing is ever sent to it. */
function patientEmail(rec: CaseRecord): string {
    return `${rec.firstName}.${rec.lastName}@example.com`.toLowerCase();
}

async function addInsurances(ctx: CaseContext, rec: CaseRecord): Promise<void> {
    for (const carrier of ctx.carriers.slice(rec.patientInsurances.length)) {
        rec.patientInsurances.push(await addPatientInsurance(ctx.client, { patientId: rec.patientId!, firstName: rec.firstName, lastName: rec.lastName }, carrier));
    }
}

// #endregion

// #region Case

/**
 * The Create a Case save (CaseSummaryComplex/Gemini/UpsertCaseSummary). Room, appointment type, physician and procedures
 * all come from this facility's own lists: the captured template's ids belong to another environment, and a case whose
 * primaryPhysicianId is not one of the facility's physicians never appears in Cases to Code.
 */
async function createCase(ctx: CaseContext, rec: CaseRecord): Promise<void> {
    const payload = template('caseSummary.req.json');
    const room = ctx.rooms[rec.roomIndex % ctx.rooms.length];
    const physician = pick(ctx.physicians);
    const appointmentType = pick(ctx.appointmentTypes);
    const slot = caseSlot(rec.dateOfService, rec.slot);
    const patient = rec.savedPatient ?? {};

    Object.assign(payload, {
        today: new Date().toISOString(),
        caseSummaryId: 0,
        patientId: rec.patientId,
        patient: { ...payload.patient, ...pickPatientFields(patient), patientId: rec.patientId, firstName: rec.firstName, lastName: rec.lastName, email: patientEmail(rec) },
        roomId: room.id,
        roomName: room.name,
        appointmentTypeId: appointmentType.id,
        appointmentTypeName: appointmentType.name,
        primaryPhysicianId: physician.id,
        primaryPhysician: physician.name,
        duration: 15,
        dateOfService: slot.dateOfService,
        procedureDt: slot.startIso,
        procedureStartDt: slot.startIso,
        procedureStopDt: slot.stopIso,
        procedureStartTime: slot.startIso,
        procedureStopTime: slot.stopIso,
        startTime: slot.startHHmm,
        endTime: slot.stopHHmm,
    });
    payload.caseGuarantor = guarantors(payload.caseGuarantor, rec);
    payload.caseInsurances = caseInsurances(rec, ctx.client.session.organizationId);
    payload.caseProcedures = caseProcedures(payload.caseProcedures[0], pickProcedures(ctx), physician, rec.selfPay);
    // A patient flagged "no patient statement" never reaches the Patient Statements tracker.
    payload.noPatientStatementTf = false;
    payload.noPatientStatementTfAtAcctLevel = false;

    const saved = await ctx.client.post('CaseSummaryComplex/Gemini/UpsertCaseSummary', payload, { contentType: 'text/json', timeoutMs: 180_000 });
    const caseSummaryId = firstNumber(saved?.caseSummaryId, saved?.caseSummaryID, saved?.result?.caseSummaryId);
    if (!caseSummaryId) throw new Error('the case was saved but the answer had no caseSummaryId');
    rec.caseSummaryId = caseSummaryId;
    rec.physician = physician.name;
    rec.room = room.name;
    rec.cptCodes = payload.caseProcedures.map((p: any) => p.cptCode);
}

function pickPatientFields(saved: any): any {
    const keys = ['gender', 'primaryAccountNumber', 'fullName', 'fullNameWithTitle', 'fullNameWithTitlePrefixAsLastName', 'externalId', 'sourceIdentifier', 'accountNumbers', 'dateOfBirth'];
    return Object.fromEntries(keys.filter((k) => saved[k] !== undefined && saved[k] !== null).map((k) => [k, saved[k]]));
}

function pickProcedures(ctx: CaseContext): FeeScheduleItem[] {
    const pool = [...ctx.procedures];
    const count = Math.max(1, Math.min(ctx.proceduresPerCase, pool.length));
    const chosen: FeeScheduleItem[] = [];
    while (chosen.length < count) chosen.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    return chosen;
}

/** `selfPay` is the Create Case "Self Pay: Yes" toggle, which marks every procedure self pay. */
function caseProcedures(base: any, items: FeeScheduleItem[], physician: Option, selfPay: boolean): any[] {
    return items.map((item, index) => {
        const f = item.raw;
        const display = `${item.cptCode}; ${f.procedure ?? f.cptProcedure?.cptDescription ?? ''}`.trim();
        return {
            ...structuredClone(base),
            physicianId: physician.id,
            physician: physician.name,
            primaryProcedureTf: index === 0,
            procedureSequence: index,
            selfPayTf: selfPay,
            cptCode: item.cptCode,
            procedureDescription: f.procedure,
            modifiedProcedureDescription: f.modifiedProcedureDescription ?? display,
            procedureDisplayName: f.procedureDisplayName ?? display,
            feeScheduleId: f.feeScheduleId,
            feeScheduleHistoryId: f.feeScheduleHistoryId,
            feeScheduleRootId: f.feeScheduleRootId,
            diagnosisList: [],
            feeScheduleItem: { ...f, status: f.status ?? 'Billable', sourceIdentifier: f.sourceIdentifier ?? ZERO_GUID },
        };
    });
}

/** The patient is their own guarantor (the wizard's default), on every insurance row the case uses. */
function guarantors(rows: any[], rec: CaseRecord): any[] {
    const own = template('caseGuarantor.json').caseGuarantor as any[];
    const self = { ...own[0], patientGuarantor: { ...own[0].patientGuarantor, patientId: rec.patientId, firstName: rec.firstName, lastName: rec.lastName, dateOfBirth: rec.dateOfBirth } };
    const second = rec.patientInsurances.length > 1 ? { ...self, sortOrder: 2 } : own[1] ?? rows?.[1];
    return [self, second].filter(Boolean);
}

/** Slots 0..2 of the case's insurances = primary, secondary, tertiary, each the patient insurance saved for it. */
function caseInsurances(rec: CaseRecord, organizationId: number): any[] {
    const base = template('caseInsurances.json').caseInsurances[0].patientInsurance;
    return [0, 1, 2].map((sortOrder) => {
        const saved = rec.patientInsurances[sortOrder];
        if (!saved) return { sortOrder, patientInsurance: {} };
        return { sortOrder, patientInsurance: { ...base, ...saved.raw, patientInsuranceId: saved.patientInsuranceId, patientId: rec.patientId, firstName: rec.firstName, lastName: rec.lastName, organizationId } };
    });
}

// #endregion

// #region Discharge, coding, charges

async function setCaseStatus(ctx: CaseContext, caseSummaryId: number, status: number): Promise<void> {
    const answer = await ctx.client.post(`CaseSummary/UpdateCaseSatus/${caseSummaryId}`, String(status));
    if (answer && typeof answer === 'object' && (answer.result === false || answer.errorMessages?.length)) {
        throw new Error(`status ${status} refused: ${answer.errorMessages?.join('; ') || 'result=false'}`);
    }
}

/** The API twin of the nursing discharge: In Progress, then Performed. The case then shows in Cases to Code. */
async function discharge(ctx: CaseContext, rec: CaseRecord): Promise<void> {
    await setCaseStatus(ctx, rec.caseSummaryId!, CASE_STATUS.inProgress);
    await setCaseStatus(ctx, rec.caseSummaryId!, CASE_STATUS.performed);
}

/** Cases to Code: the scheduled procedures become performed items with a diagnosis, Ready for Charge = Yes. */
async function code(ctx: CaseContext, rec: CaseRecord): Promise<void> {
    const scheduled = await scheduledProcedures(ctx, rec.caseSummaryId!);
    const diagnosis = await findDiagnosis(ctx, ctx.diagnosisCode);
    const base = template('CasesToCodeRequest.json').performedItems[0];
    const performedItems = scheduled.map((sp: any, index: number) => ({
        ...structuredClone(base),
        units: 1,
        sortorder: index,
        caseSummaryId: rec.caseSummaryId,
        caseProcedureId: sp.caseProcedureId,
        providerId: sp.physicianId ?? sp.providerId,
        physicianName: sp.physicianName ?? rec.physician,
        cptProcedureId: sp.cptProcedureId,
        cptCode: sp.cptCode,
        cptProcedureDescription: sp.cptDescription ?? sp.procedureDescription,
        feeScheduleId: sp.feeScheduleId,
        feeScheduleItem: sp.feeScheduleItem ?? base.feeScheduleItem,
        diagnosisList: [{ ...(base.diagnosisList?.[0] ?? {}), sortOrder: 0, diagnosisId: diagnosis.id, dictionaryItem: { ...(base.diagnosisList?.[0]?.dictionaryItem ?? {}), id: diagnosis.id, quickCode: diagnosis.code, value: diagnosis.description } }],
    }));
    const saved = await ctx.client.post('CaseToCode/SavePerformedItems', { performedItems, deletedPerformedItems: [] });
    rec.performedItems = extractPerformed(saved);
    await setCaseStatus(ctx, rec.caseSummaryId!, CASE_STATUS.readyToCharge);
}

/** A new case's procedures can take a moment to be readable; asks a few times before giving up. */
async function scheduledProcedures(ctx: CaseContext, caseSummaryId: number): Promise<any[]> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const list = await ctx.client.get(`ScheduledCaseProcedure/GetScheduledProcedures/${caseSummaryId}/false`);
        if (Array.isArray(list) && list.length) return list;
        await sleep(750);
    }
    throw new Error('the case has no scheduled procedures to code');
}

const diagnosisCache = new Map<string, Promise<{ id: number; code: string; description: string }>>();

/** ICD search takes the first three characters as a quoted string, the way the Coding screen sends it. */
function findDiagnosis(ctx: CaseContext, code: string) {
    const key = `${ctx.client.session.apiUrl}|${code}`;
    if (!diagnosisCache.has(key)) {
        diagnosisCache.set(key, (async () => {
            const list = await ctx.client.post('ICDCodeClassification/GetICDCodeClassifications', JSON.stringify(code.slice(0, 3)));
            const all = Array.isArray(list) ? list : [];
            const hit = all.find((d: any) => d.icdCode === code) ?? all[0];
            if (!hit) throw new Error(`diagnosis ${code} was not found`);
            return { id: firstNumber(hit.icdCodeId, hit.id)!, code: hit.icdCode, description: firstString(hit.icdCodeDescription, hit.description) ?? '' };
        })());
        diagnosisCache.get(key)!.catch(() => diagnosisCache.delete(key));
    }
    return diagnosisCache.get(key)!;
}

function extractPerformed(answer: any): any[] {
    const stack = [answer];
    while (stack.length) {
        const current = stack.pop();
        if (!current || typeof current !== 'object') continue;
        if (Array.isArray(current.performedItems) && current.performedItems.length) return current.performedItems;
        stack.push(...(Array.isArray(current) ? current : Object.values(current)));
    }
    return [];
}

/** Charge Entry: one charge per performed procedure into the run's period/batch, billed to the primary insurance. */
async function charge(ctx: CaseContext, rec: CaseRecord): Promise<void> {
    if (!ctx.periodBatch) throw new Error('no period/batch chosen for the charges');
    const performed: any[] = rec.performedItems ?? [];
    if (!performed.length) throw new Error('coding answered without performed procedures (retry the case from Code)');
    const { periodId, periodName, batchId, batchDescription } = ctx.periodBatch;
    const primary = rec.patientInsurances[0];

    const entries = performed.map((p: any, index: number) => {
        const entry = template('chargeEntryRequest.json')[0];
        const amount = ctx.amounts[p.cptCode] ?? p.feeScheduleItem?.amount ?? 100;
        const details = { ...(entry.transactionList?.[0]?.chargeDetails ?? {}), performedCaseProcedureId: p.performedCaseProcedureId, balance: amount, transactionId: 0, generateBill: true, generateBillStateModified: true };
        delete details.peformedCaseProcedureId;
        const transaction = { ...(entry.transactionList?.[0] ?? {}), period: { periodId, periodName }, batch: { batchId, batchDescription }, periodId, batchId, batchDescription, transactionId: 0, amount, chargeDetails: details };
        return {
            ...entry,
            cptProcedureId: p.cptProcedureId, patientId: p.patientId ?? rec.patientId, caseProcedureId: p.caseProcedureId, cptCode: p.cptCode,
            physicianName: p.physicianName, performedCaseProcedureId: p.performedCaseProcedureId, units: 1, sortorder: index,
            feeScheduleItem: p.feeScheduleItem, cptProcedureDescription: p.cptProcedureDescription, caseSummaryId: rec.caseSummaryId,
            providerId: p.providerId, feeScheduleId: p.feeScheduleId, diagnosisList: p.diagnosisList,
            transactionList: [transaction],
            chargeTransaction: { ...(entry.chargeTransaction ?? {}), ...transaction, chargeDetails: { ...details } },
            primaryInsuranceId: primary?.patientInsuranceId ?? null,
            primaryInsurancesList: primary ? [{ patientInsuranceId: primary.patientInsuranceId, displayName: primary.displayName }] : [],
            secondaryInsurancesList: [], tertiaryInsurancesList: [],
            chargeEntryPatientInsMap: primary ? [{ chargeEntryDetailsId: 0, patientInsuranceId: primary.patientInsuranceId, insuranceUsedInTransfer: false, sortOrder: 0, canBillGenerated: false, sourceIdentifier: ZERO_GUID }] : [],
            controlsModifiedInEditChargeMode: false, isAmountChanged: true, generateBill: true, generateBillStateModified: true, eventSource: 'ReadyForBillBtn',
        };
    });
    const saved = await ctx.client.post('CaseToCharge/SavePerformedProcedure/', entries);
    if (saved === null || saved === undefined) throw new Error('charge save answered empty');
    await setCaseStatus(ctx, rec.caseSummaryId!, CASE_STATUS.readyForBill);
}

// #endregion

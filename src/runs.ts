import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CaseContext, CaseRecord, TrackerId } from './flows/case-flow.ts';
import type { CarrierSetup } from './flows/insurance.ts';
import type { PeriodBatch } from './flows/period-batch.ts';
import type { Lookups, Option } from './lookups.ts';
import type { ApiLog, SisClient } from './sis-client.ts';
import { advanceCase, MAX_PATIENTS_PER_ERA, remitCases, STAGES, TRACKERS } from './flows/case-flow.ts';
import { createCarrier } from './flows/insurance.ts';
import { createPeriodBatch } from './flows/period-batch.ts';
import type { ClaimStatusCategory } from './flows/interfaces.ts';
import { CLAIM_STATUS_CATEGORIES, externalMrn, sendAdtPatient, sendClaimStatus } from './flows/interfaces.ts';
import type { EraOutcome } from './flows/remittance.ts';
import { ERA_OUTCOMES, missingEraSettings, prepareFacilityDetails, remittancesInTracker } from './flows/remittance.ts';
import type { RcmTemplateChange } from './flows/rcm.ts';
import { openRcmTemplates, restoreRcmTemplates, SEEDED_CARRIER_CLASSIFICATION } from './flows/rcm.ts';
import { cleanSuffix, errorMessage, patientName, pool, randomDob, randomTag, sleep, todayYmd } from './util.ts';

const RUN_DIR = join(import.meta.dirname, '..', 'runs');
const LOG_LIMIT = 3000;

/** 'cleanup' and 'features' are only in history files from earlier versions. */
export type RunKind = 'cases' | 'periodBatches' | 'cleanup' | 'features' | 'rcmRestore' | 'interfaces';

/** One record a Period & Batch run created (or failed to). */
export type CreatedItem = { name: string; id?: number; ok: boolean; error?: string };

export type CaseRunRequest = {
    /** How many cases to put in each tracker, e.g. { casesToCode: 5, patientStatements: 20 }. */
    trackers: Partial<Record<TrackerId, number>>;
    suffix?: string;
    /** Dates of service (yyyy-mm-dd) picked on the calendar; cases are spread evenly over them. Default: today. */
    dates?: string[];
    physicianIds?: number[];
    proceduresPerCase?: number;
    amounts?: Record<string, number>;
    /**
     * Insurance of the cases whose tracker takes either billing: 0 = self pay; 1..3 = primary / + secondary /
     * + tertiary, each a new carrier made for this run. Insurance Billing cases always get at least a primary;
     * Patient Statements cases are always self pay.
     */
    insuranceCount?: number;
    /** The ERA every Remittance Posting case gets, or 'mixed' to rotate through all of them (default partial). */
    eraOutcome?: EraOutcome | 'mixed';
    /** How many Remittance Posting patients one ERA (one tracker row, one check number) carries (default 1). */
    patientsPerEra?: number;
    periodBatch?: { mode: 'create' } | { mode: 'existing'; periodId: number; batchId: number };
    diagnosisCode?: string;
    concurrency?: number;
};

export type Check = { name: string; ok: boolean; detail: string };

export type Run = {
    id: string;
    kind: RunKind;
    title: string;
    status: 'running' | 'done' | 'stopped' | 'failed';
    environment: { apiUrl: string; organizationId: number; username: string };
    startedAt: string;
    finishedAt?: string;
    tag: string;
    setup: { carriers: CarrierSetup[]; periodBatch?: PeriodBatch; notes: string[] };
    cases: CaseRecord[];
    items: CreatedItem[];
    total: number;
    error?: string;
    /** What a running run is doing after its cases, e.g. waiting for ERAs to reach the tracker. */
    phase?: string;
    log: ApiLog[];
    stopRequested?: boolean;
    /** Kept so failed cases can be retried with the same picks; not persisted. */
    context?: CaseContext;
    concurrency?: number;
    /** Case runs: the request they were started with (Run again, and Retry failed after a restart or from History). */
    request?: CaseRunRequest;
    /** Case runs with RCM cases: the RCM template days the run set to 0, with the values to restore. */
    rcmChanges?: RcmTemplateChange[];
};

const runs = new Map<string, Run>();

/** Charge Entry and every stage after it post charges, so they need a period/batch. */
const chargesPosted = (stage: string) => STAGES.indexOf(stage as (typeof STAGES)[number]) >= STAGES.indexOf('charged');

// #region Case runs

/** Turns the form into concrete picks, and says what is missing before anything is created. */
export function resolveCaseRun(req: CaseRunRequest, lookups: Lookups): { checks: Check[]; picks: Omit<CaseContext, 'client' | 'carriers' | 'periodBatch' | 'runTag'> } {
    const choose = <T extends Option>(all: T[], ids?: number[]) => (ids?.length ? all.filter((o) => ids.includes(o.id)) : all);
    const rooms = lookups.rooms;
    const appointmentTypes = lookups.appointmentTypes;
    const physicians = choose(lookups.physicians, req.physicianIds);
    const procedures = lookups.feeSchedule;
    const count = (id: TrackerId) => casesFor(req, id);
    const total = TRACKERS.reduce((sum, t) => sum + count(t.id), 0);
    const needsCharge = TRACKERS.some((t) => chargesPosted(t.stage) && count(t.id) > 0);
    const listCheck = (name: string, list: Option[], key: string) => ({
        name, ok: list.length > 0,
        detail: list.length ? `${list.length} available${list.length <= 3 ? `: ${list.map((o) => o.name).join(', ')}` : ''}` : (lookups.errors[key] ? `could not load: ${lookups.errors[key]}` : 'none found for this facility'),
    });
    const checks: Check[] = [
        { name: 'Number of cases', ok: total > 0 && total <= 2000, detail: total > 0 ? `${total} case(s)` : 'enter how many cases to create' },
        { ...listCheck('Rooms', rooms, 'rooms'), detail: rooms.length ? `cases are spread over all ${rooms.length} room(s): ${rooms.map((r) => r.name).join(', ')}` : listCheck('Rooms', rooms, 'rooms').detail },
        listCheck('Appointment types', appointmentTypes, 'appointmentTypes'),
        listCheck('Physicians', physicians, 'physicians'),
        listCheck('Procedures (fee schedule CPTs)', procedures, 'feeSchedule'),
    ];
    if (needsCharge && req.periodBatch?.mode === 'existing') {
        const period = lookups.periods.find((p) => p.id === Number(req.periodBatch && 'periodId' in req.periodBatch ? req.periodBatch.periodId : 0));
        const batch = period?.batches.find((b) => req.periodBatch && 'batchId' in req.periodBatch && b.id === Number(req.periodBatch.batchId));
        checks.push({ name: 'Period / batch', ok: !!batch, detail: batch ? `${period!.name} / ${batch.name}` : 'pick an open period and batch, or let the run create one' });
    }
    if (count('patientStatements') > 0) {
        checks.push({ name: 'Patient Statements', ok: true, detail: `${count('patientStatements')} self-pay case(s) charged to Ready for Bill. The facility's Patient Statements settings (e.g. minimum balance) still apply.` });
    }
    if (count('rcm') > 0) {
        checks.push({ name: 'Revenue Cycle Management', ok: true, detail: `${count('rcm')} case(s) charged to Ready for Bill. The RCM templates they fall under (${(Number(req.insuranceCount) || 0) > 0 ? `classification ${SEEDED_CARRIER_CLASSIFICATION}` : 'Self-Pay with No Insurance, Patient Responsibility'}) are set to 0 days so they show today; the run can restore them.` });
    }
    if (count('remittancePosting') > 0) {
        const missing = missingEraSettings();
        checks.push({
            name: 'Electronic remittance (835)', ok: !missing.length,
            detail: missing.length
                ? `no ERA app values: clone the SIS automation repo next to the seeder (or set SIS_AUTOMATION_REPO), or run npm run setup; then restart the seeder`
                : `${eraGrouping(req)}: ${count('remittancePosting')} insured case(s) charged, then their ERAs posted from the primary carrier. The facility needs a federal tax id.`,
        });
    }
    const dates = caseDates(req);
    const perSlot = Math.ceil(total / Math.max(1, dates.length * rooms.length));
    checks.push({
        name: 'Date of service', ok: dates.length > 0 && perSlot <= 44,
        detail: perSlot > 44
            ? `${total} cases need more than one day of 15-minute slots per room; pick more dates`
            : `${dates.length} day(s): ${dates.join(', ')}${total ? ` · about ${perSlot} case(s) per room per day` : ''}`,
    });
    return {
        checks,
        picks: {
            rooms, appointmentTypes, physicians, procedures,
            proceduresPerCase: Math.max(1, Math.min(Number(req.proceduresPerCase) || 1, 5)),
            amounts: req.amounts ?? {},
            diagnosisCode: (req.diagnosisCode || 'H44.001').trim().toUpperCase(),
        },
    };
}

export function startCaseRun(base: SisClient, req: CaseRunRequest, lookups: Lookups): Run {
    // One case run at a time per sign-in: a second one would share its carriers, slots and session.
    assertIdle(base);
    const { checks, picks } = resolveCaseRun(req, lookups);
    const failed = checks.filter((c) => !c.ok);
    if (failed.length) throw new Error(failed.map((c) => `${c.name}: ${c.detail}`).join('; '));

    const tag = cleanSuffix(req.suffix) || randomTag();
    const days = caseDates(req);
    const roomCount = lookups.rooms.length;
    const insuranceCount = Math.max(0, Math.min(Number(req.insuranceCount) || 0, 3));
    const cases: CaseRecord[] = [];
    const outcomes = Object.keys(ERA_OUTCOMES) as EraOutcome[];
    const eraOutcome = (n: number): EraOutcome => (req.eraOutcome === 'mixed' ? outcomes[n % outcomes.length] : outcomes.includes(req.eraOutcome as EraOutcome) ? req.eraOutcome as EraOutcome : 'partial');
    for (const tracker of TRACKERS) {
        const selfPay = tracker.billing === 'selfPay' || (tracker.billing === 'either' && insuranceCount === 0);
        for (let i = 0; i < casesFor(req, tracker.id); i += 1) {
            const index = cases.length;
            const name = patientName(index, tag);
            cases.push({
                // Day first, then room, then the next 15-minute slot: no two cases share a room at the same time.
                index: index + 1, ...name, dateOfBirth: randomDob(), dateOfService: days[index % days.length],
                roomIndex: Math.floor(index / days.length) % roomCount, slot: Math.floor(index / (days.length * roomCount)),
                tracker: tracker.id, target: tracker.stage, selfPay, reached: null, patientInsurances: [], cptCodes: [], steps: [],
                ...(tracker.stage === 'remitted' ? { eraOutcome: eraOutcome(i) } : {}),
            });
        }
    }
    const run = newRun(base, 'cases', `${cases.length} clinical case(s)`, tag, cases.length);
    const client = runClient(base, run);
    run.cases = cases;
    run.request = { ...req, suffix: tag };
    run.concurrency = Math.max(1, Math.min(Number(req.concurrency) || 4, 10));
    void (async () => {
        try {
            const carriers: CarrierSetup[] = [];
            const carrierCount = cases.some((c) => !c.selfPay) ? Math.max(1, insuranceCount) : 0;
            for (let i = 1; i <= carrierCount; i += 1) {
                carriers.push(await createCarrierWithFreeName(client, `Ins${tag}${['P', 'S', 'T'][i - 1]}`));
            }
            run.setup.carriers = carriers;
            if (carriers.length) run.setup.notes.push(`Created ${carriers.map((c) => c.carrierName).join(', ')} and attached them to every insured patient.`);
            const selfPayCount = cases.filter((c) => c.selfPay).length;
            if (selfPayCount) run.setup.notes.push(`${selfPayCount} case(s) are self pay (no insurance), so the patient owes the balance.`);
            run.setup.periodBatch = await periodBatchFor(client, req, lookups, tag, days[0], cases.some((c) => chargesPosted(c.target)));
            if (run.setup.periodBatch) run.setup.notes.push(`Charges go to ${run.setup.periodBatch.periodName} / ${run.setup.periodBatch.batchDescription}.`);
            await prepareRemittances(client, run);
            await prepareRcm(client, run);
            run.context = { client, ...picks, carriers, periodBatch: run.setup.periodBatch, runTag: tag };
            await pool(cases, run.concurrency!, (rec) => advanceCase(run.context!, rec), () => !!run.stopRequested);
            await postRemittances(run);
            await confirmRemittances(run);
            finish(run);
        } catch (err) {
            finish(run, `Run setup failed: ${errorMessage(err)}`);
        }
    })();
    return run;
}

/**
 * The carrier is saved under the run's name; when that name is already taken (the same tag used again), the save
 * answers without a carrier id, so the name gets a short random suffix and is saved once more.
 */
async function createCarrierWithFreeName(client: SisClient, name: string): Promise<CarrierSetup> {
    try {
        return await createCarrier(client, name);
    } catch (err) {
        if (!/no carrier id/.test(errorMessage(err))) throw err;
        return createCarrier(client, `${name}${randomTag(3)}`);
    }
}

/** The calendar's dates, valid and in order; today when none were picked. */
function caseDates(req: CaseRunRequest): string[] {
    const picked = [...new Set((req.dates ?? []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort().slice(0, 366);
    return picked.length ? picked : [todayYmd()];
}

async function periodBatchFor(client: SisClient, req: CaseRunRequest, lookups: Lookups, tag: string, firstDay: string, needed: boolean): Promise<PeriodBatch | undefined> {
    if (!needed) return undefined;
    const choice = req.periodBatch;
    if (choice?.mode === 'existing') {
        const period = lookups.periods.find((p) => p.id === Number(choice.periodId))!;
        const batch = period.batches.find((b) => b.id === Number(choice.batchId))!;
        return { periodId: period.id, periodName: period.name, batchId: batch.id, batchDescription: batch.name };
    }
    return createPeriodBatch(client, tag, firstDay);
}

/** Notes a retry rewrites instead of adding again. */
const ERA_PAYEE_NOTE = 'ERAs are paid to';
const ERA_TRACKER_NOTE = 'Remittance Posting tracker:';

/**
 * RCM cases are listed only after their template's days; the templates this run's RCM cases fall under (insured:
 * the seeded carriers' classification; self pay: the self-pay templates) are set to 0 days before the cases start.
 */
async function prepareRcm(client: SisClient, run: Run): Promise<void> {
    const rcm = run.cases.filter((c) => c.tracker === 'rcm');
    if (!rcm.length) return;
    try {
        const { changes, matched } = await openRcmTemplates(client, rcm.some((c) => !c.selfPay), rcm.some((c) => c.selfPay));
        run.rcmChanges = changes;
        if (!matched.length) run.setup.notes.push(`RCM: no RCM template matches these cases (classification ${SEEDED_CARRIER_CLASSIFICATION} or the self-pay templates), so they show only after the facility's own rules.`);
        else if (changes.length) run.setup.notes.push(`RCM: set ${changes.map((c) => `${c.name} (${c.before} → 0 days)`).join(', ')} so the cases show today. Use "Restore RCM template days" on this run when done.`);
        else run.setup.notes.push(`RCM: ${matched.map((t) => t.name).join(', ')} already at 0 days.`);
    } catch (err) {
        run.setup.notes.push(`RCM: the templates could not be set to 0 days (${errorMessage(err)}); the cases show after the facility's template days.`);
    }
}

/** Puts back the RCM template days a case run changed, as its own run in History. */
export function startRcmRestoreRun(base: SisClient, sourceId: string): Run {
    const source = getRun(sourceId);
    if (!source || source.kind !== 'cases') throw new Error('no such case run');
    sameFacility(base, source);
    const changes = source.rcmChanges ?? [];
    if (!changes.length) throw new Error('that run changed no RCM template days');
    const run = newRun(base, 'rcmRestore', `Restore ${changes.length} RCM template(s) changed by run ${source.tag}`, source.tag, changes.length);
    const client = runClient(base, run);
    void (async () => {
        try {
            for (const line of await restoreRcmTemplates(client, changes)) run.items.push({ name: line, ok: true });
            source.rcmChanges = [];
            save(source);
            finish(run);
        } catch (err) {
            finish(run, errorMessage(err));
        }
    })();
    return run;
}

/** The ERA payee (the facility's tax id) is read once, before the cases run in parallel. */
async function prepareRemittances(client: SisClient, run: Run): Promise<void> {
    if (!run.cases.some((c) => c.target === 'remitted' && !c.error?.startsWith('Create'))) return;
    run.setup.notes = run.setup.notes.filter((n) => !n.startsWith(ERA_PAYEE_NOTE));
    try {
        const facility = await prepareFacilityDetails(client);
        run.setup.notes.push(`${ERA_PAYEE_NOTE} ${facility.name} (federal tax id ending ${facility.taxId.slice(-4)}).`);
    } catch (err) {
        run.setup.notes.push(`${ERA_PAYEE_NOTE} nobody: the facility's federal tax id could not be read, so its ERAs will fail (${errorMessage(err)}).`);
    }
}

const patientsPerEra = (req?: CaseRunRequest) => Math.max(1, Math.min(Math.floor(Number(req?.patientsPerEra)) || 1, MAX_PATIENTS_PER_ERA));

/**
 * How many cases a tracker gets. For Remittance Posting the count is the number of tracker records (ERAs), and each
 * record holds Patients per ERA patients, so it makes count × patients per ERA cases.
 */
function casesFor(req: CaseRunRequest, id: TrackerId): number {
    const wanted = Math.max(0, Math.floor(Number(req.trackers?.[id])) || 0);
    return id === 'remittancePosting' ? wanted * patientsPerEra(req) : wanted;
}

/** "3 Remittance Posting record(s) of 4 patient(s)" for the setup check. */
function eraGrouping(req: CaseRunRequest): string {
    const records = Math.max(0, Math.floor(Number(req.trackers?.remittancePosting)) || 0);
    return `${records} Remittance Posting record(s) (one ERA and check number each) of ${patientsPerEra(req)} patient(s)`;
}

/** After the cases are charged: their ERAs, several patients each when asked. */
async function postRemittances(run: Run): Promise<void> {
    if (!run.context || run.stopRequested || !run.cases.some((c) => c.target === 'remitted' && c.reached === 'charged' && !c.error)) return;
    run.phase = 'Posting electronic remittances (835)…';
    try {
        await remitCases(run.context, run.cases, patientsPerEra(run.request), () => !!run.stopRequested);
    } finally {
        run.phase = undefined;
    }
}

const TRACKER_WAIT_MS = 5 * 60_000;
const TRACKER_POLL_MS = 15_000;

/**
 * Remittance Posting cases are only done when their ERA is in the tracker. The intake processes ERAs in a background
 * job, so the list is asked every 15 s for up to 5 minutes; each case shows whether its check number arrived.
 */
async function confirmRemittances(run: Run): Promise<void> {
    const posted = run.cases.filter((c) => c.checkNumber && c.reached === 'remitted' && !c.error && !c.inTracker);
    if (!posted.length || !run.context) return;
    // Several patients can share one ERA (one check number), so ERAs are counted by check number.
    const checks = [...new Set(posted.map((c) => c.checkNumber!))];
    run.setup.notes = run.setup.notes.filter((n) => !n.startsWith(ERA_TRACKER_NOTE));
    run.phase = `Waiting for ${checks.length} ERA(s) to reach the Remittance Posting tracker…`;
    const started = Date.now();
    try {
        let found = new Set<string>();
        while (!run.stopRequested) {
            found = await remittancesInTracker(run.context.client, checks);
            for (const c of posted) c.inTracker = found.has(c.checkNumber!);
            if (found.size === checks.length || Date.now() - started > TRACKER_WAIT_MS) break;
            await sleep(TRACKER_POLL_MS);
        }
        const missing = checks.filter((check) => !found.has(check));
        run.setup.notes.push(`${ERA_TRACKER_NOTE} ` + (missing.length
            ? `${checks.length - missing.length} of ${checks.length} ERA(s) are in the Remittance Posting tracker; ${missing.length} not yet after ${Math.round((Date.now() - started) / 1000)} s (the intake job may still be running: search the tracker by check number, e.g. ${missing[0]}).`
            : `all ${checks.length} ERA(s) (${posted.length} patient(s)) are in the tracker (payer ${run.context.carriers[0]?.carrierName}).`));
    } catch (err) {
        for (const c of posted) c.inTracker = undefined;
        run.setup.notes.push(`${ERA_TRACKER_NOTE} ${checks.length} ERA(s) posted; this sign-in can't read the tracker list to confirm them (${errorMessage(err)}). Search the tracker by payer ${run.context.carriers[0]?.carrierName} or by check number.`);
    } finally {
        run.phase = undefined;
    }
}

/**
 * Runs the failed cases of a finished run again, each from the step it stopped at. A run from History (or from before
 * a restart) gets its working context back from its saved request, the facility's lists, and its own carriers and
 * period/batch, so the retried cases continue with exactly what the run set up.
 */
export function retryFailed(base: SisClient, run: Run, lookups: Lookups): number {
    if (run.status === 'running') throw new Error('the run is still going');
    assertIdle(base);
    const failed = run.cases.filter((c) => c.error);
    if (!failed.length) return 0;
    if (!run.context) {
        if (!run.request) throw new Error('this run is from an older version of the seeder and has no saved request; use a new run instead');
        sameFacility(base, run);
        const { picks } = resolveCaseRun(run.request, lookups);
        runs.set(run.id, run);
        run.context = { client: runClient(base, run), ...picks, carriers: run.setup.carriers, periodBatch: run.setup.periodBatch, runTag: run.tag };
        run.concurrency ??= Math.max(1, Math.min(Number(run.request.concurrency) || 4, 10));
    }
    run.status = 'running';
    run.stopRequested = false;
    run.finishedAt = undefined;
    run.error = undefined;
    void (async () => {
        await prepareRemittances(run.context!.client, run);
        await pool(failed, run.concurrency ?? 4, (rec) => advanceCase(run.context!, rec), () => !!run.stopRequested);
        await postRemittances(run);
        await confirmRemittances(run);
        finish(run);
    })();
    return failed.length;
}

// #endregion

/**
 * Starts a case run that failed before its cases (e.g. in setup) again: the same request under a fresh tag, so patient
 * names and carriers never collide with what the failed attempt may have created.
 */
export function rerunFailedRun(base: SisClient, sourceId: string, lookups: Lookups): Run {
    const source = getRun(sourceId);
    if (!source || source.kind !== 'cases') throw new Error('no such case run');
    if (source.status !== 'failed') throw new Error('only a run that failed can be run again; use Retry failed for its failed cases');
    if (!source.request) throw new Error('this run is from an older version of the seeder and has no saved request; use a new run instead');
    sameFacility(base, source);
    return startCaseRun(base, { ...source.request, suffix: `${cleanSuffix(source.tag).slice(0, 16)}${randomTag(3)}` }, lookups);
}

// #region Period & batch runs

export type PeriodBatchRunRequest = {
    count: number;
    suffix?: string;
    /** The period covers the month of this date (default today). */
    periodBatch?: { month?: string };
};

export function startPeriodBatchRun(base: SisClient, req: PeriodBatchRunRequest): Run {
    const count = Math.max(1, Math.min(Number(req.count) || 1, 50));
    const tag = cleanSuffix(req.suffix) || randomTag();
    const run = newRun(base, 'periodBatches', `${count} period(s) with a batch`, tag, count);
    const client = runClient(base, run);
    const month = /^\d{4}-\d{2}-\d{2}$/.test(req.periodBatch?.month ?? '') ? req.periodBatch!.month! : todayYmd();
    void (async () => {
        try {
            for (let i = 1; i <= count && !run.stopRequested; i += 1) {
                try {
                    const pb = await createPeriodBatch(client, count === 1 ? tag : `${tag}${i}`, month);
                    run.items.push({ name: `${pb.periodName} / ${pb.batchDescription}`, id: pb.batchId, ok: true });
                } catch (err) {
                    run.items.push({ name: `#${i}`, ok: false, error: errorMessage(err) });
                }
            }
            finish(run);
        } catch (err) {
            finish(run, errorMessage(err));
        }
    })();
    return run;
}

// #endregion

// #region Run helpers

/** One run at a time per sign-in: a second one would share its carriers, slots and session (and the enterprise switch). */
function assertIdle(base: SisClient): void {
    const { username, organizationId, apiUrl } = base.session;
    const busy = [...runs.values()].some((r) => r.status === 'running' && r.environment.username === username && r.environment.organizationId === organizationId && r.environment.apiUrl === apiUrl);
    if (busy) throw new Error('a run is still going on this sign-in; start this when it has finished');
}

function sameFacility(base: SisClient, source: Run): void {
    const { apiUrl, organizationId } = base.session;
    if (source.environment.apiUrl !== apiUrl || source.environment.organizationId !== organizationId) {
        throw new Error(`that run was on facility ${source.environment.organizationId} at ${hostOf(source.environment.apiUrl)}; sign in there first`);
    }
}


function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

// #endregion


// #region Interface runs (277 claim status, inbound ADT)

export type ClaimStatusRunRequest = { cases: { runId: string; caseSummaryId: number }[]; category: ClaimStatusCategory; icn?: string; remark?: string };

/**
 * One 277 per picked case, from its primary carrier, filled with the case's patient, member id and DOS. The ICN and trace
 * number of each are kept on the run so the tester can find them in Claim Status History / the RCM tracker.
 */
export function startClaimStatusRun(base: SisClient, req: ClaimStatusRunRequest): Run {
    const known = new Map(seededCases(base, 5000).map((c) => [`${c.runId}|${c.caseSummaryId}`, c]));
    const picked = (req.cases ?? []).map((p) => known.get(`${p.runId}|${p.caseSummaryId}`)).filter((c): c is SeededCase => !!c);
    if (!picked.length) throw new Error('pick at least one seeded case of this facility');
    const category = (req.category in CLAIM_STATUS_CATEGORIES ? req.category : 'P1') as ClaimStatusCategory;
    const run = newRun(base, 'interfaces', `277 claim status (${category}) for ${picked.length} case(s)`, randomTag(), picked.length);
    const client = runClient(base, run);
    void (async () => {
        for (const c of picked) {
            if (run.stopRequested) break;
            const name = `${c.lastName}, ${c.firstName} · case ${c.caseSummaryId} · DOS ${c.dateOfService}`;
            const payerName = c.insurances[0]?.split(',')[0]?.trim();
            if (!payerName) {
                run.items.push({ name, id: c.caseSummaryId, ok: false, error: 'self pay: a 277 comes from the patient\'s insurance, and this case has none' });
                continue;
            }
            try {
                const { icn, trace } = await sendClaimStatus(client, { ...c, payerName }, { category, icn: picked.length === 1 ? req.icn : undefined, remark: req.remark });
                run.items.push({ name: `${name} · payer ${payerName} · ICN ${icn} · TRN ${trace}`, id: c.caseSummaryId, ok: true });
            } catch (err) {
                run.items.push({ name, id: c.caseSummaryId, ok: false, error: errorMessage(err) });
            }
        }
        run.setup.notes.push('The claim status process runs in the background: it can take a few minutes to show in the case\'s Claim Status History (Facesheet > Transactions) and the RCM tracker\'s Insurance tab.');
        finish(run);
    })();
    return run;
}

export type AdtRunRequest = { count: number; sourceIdentifier?: string; withInsurance?: boolean; suffix?: string };

/** N new patients through the inbound ADT interface, each with its own random external MRN (and a primary insurance). */
export function startAdtRun(base: SisClient, req: AdtRunRequest): Run {
    const count = Math.max(1, Math.min(Number(req.count) || 1, 200));
    const tag = cleanSuffix(req.suffix) || randomTag();
    const run = newRun(base, 'interfaces', `Inbound ADT: ${count} patient(s)`, tag, count);
    const client = runClient(base, run);
    const carrier = req.withInsurance ? `Ins${tag}ADT` : undefined;
    void (async () => {
        for (let i = 0; i < count && !run.stopRequested; i += 1) {
            const { firstName, lastName } = patientName(i, tag);
            const externalMRN = externalMrn();
            const dob = randomDob().replace(/\//g, '-');
            const name = `${lastName}, ${firstName} · DOB ${dob} · external MRN ${externalMRN}`;
            try {
                await sendAdtPatient(client, { firstName, lastName, dob, externalMRN }, { sourceIdentifier: req.sourceIdentifier, insuranceCarrier: carrier });
                run.items.push({ name, ok: true });
            } catch (err) {
                run.items.push({ name, ok: false, error: errorMessage(err) });
            }
        }
        run.setup.notes.push(`Search the patients by external MRN (Failed Import Manager, or patient search) or by the last-name tag ${tag}.${carrier ? ` Their insurance carrier is ${carrier}.` : ''} The facility needs Inbound ADT on (Enterprise > Facility Management > Internal) and the data source registered.`);
        finish(run);
    })();
    return run;
}

// #endregion

// #region Seeded cases (what the Interfaces tab sends messages about)

export type SeededCase = {
    runId: string;
    runTag: string;
    tracker: string;
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    patientId: number;
    caseSummaryId: number;
    dateOfService: string;
    reached: string | null;
    cptCodes: string[];
    insurances: string[];
    memberId?: string;
    checkNumber?: string;
    cancelled?: boolean;
};

/**
 * Every case the seeder created on this environment and facility, newest run first, from this server's runs and the
 * saved history. Only cases that exist (have a case id) and are not cancelled.
 */
export function seededCases(base: SisClient, limit = 500): SeededCase[] {
    const { apiUrl, organizationId } = base.session;
    const result: SeededCase[] = [];
    for (const summary of listRuns()) {
        if (summary.kind !== 'cases' || summary.environment.apiUrl !== apiUrl || summary.environment.organizationId !== organizationId) continue;
        const run = getRun(summary.id);
        for (const c of run?.cases ?? []) {
            if (!c.caseSummaryId || !c.patientId || c.cancelled) continue;
            result.push({
                runId: run!.id, runTag: run!.tag, tracker: c.tracker, firstName: c.firstName, lastName: c.lastName, dateOfBirth: c.dateOfBirth,
                patientId: c.patientId, caseSummaryId: c.caseSummaryId, dateOfService: c.dateOfService, reached: c.reached,
                cptCodes: c.cptCodes, insurances: c.patientInsurances.map((i) => i.displayName),
                memberId: c.patientInsurances[0]?.raw?.insuranceId != null ? String(c.patientInsurances[0].raw.insuranceId) : undefined,
                checkNumber: c.checkNumber,
            });
            if (result.length >= limit) return result;
        }
    }
    return result;
}

// #endregion

// #region Bookkeeping

function newRun(client: SisClient, kind: RunKind, title: string, tag: string, total: number): Run {
    const { apiUrl, organizationId, username } = client.session;
    const run: Run = {
        id: `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${kind}-${tag}`,
        kind, title, tag, total, status: 'running',
        environment: { apiUrl, organizationId, username },
        startedAt: new Date().toISOString(),
        setup: { carriers: [], notes: [] },
        cases: [], items: [], log: [],
    };
    runs.set(run.id, run);
    return run;
}

/** A client whose API calls land in this run's log (the token is never part of a log entry). */
function runClient(base: SisClient, run: Run): SisClient {
    return base.withLogger((entry: ApiLog) => {
        run.log.push(entry);
        if (run.log.length > LOG_LIMIT) run.log.splice(0, run.log.length - LOG_LIMIT);
    });
}

function finish(run: Run, error?: string): void {
    run.error = error;
    run.status = error ? 'failed' : run.stopRequested ? 'stopped' : 'done';
    run.finishedAt = new Date().toISOString();
    save(run);
}

function save(run: Run): void {
    try {
        mkdirSync(RUN_DIR, { recursive: true });
        writeFileSync(join(RUN_DIR, `${run.id}.json`), JSON.stringify(publicRun(run, true, true), null, 2));
    } catch {
        // history is a convenience; a read-only folder must not fail the run
    }
}

export function stopRun(id: string): void {
    const run = runs.get(id);
    if (run?.status === 'running') run.stopRequested = true;
}

export function getRun(id: string): Run | undefined {
    if (runs.has(id)) return runs.get(id);
    try {
        const saved = JSON.parse(readFileSync(join(RUN_DIR, `${id.replace(/[^\w-]/g, '')}.json`), 'utf8')) as Run;
        return saved;
    } catch {
        return undefined;
    }
}

/** Runs of this server plus the saved history, newest first. */
export function listRuns(): { id: string; kind: RunKind; title: string; status: string; startedAt: string; environment: Run['environment'] }[] {
    const seen = new Map<string, Run>();
    try {
        for (const file of readdirSync(RUN_DIR).filter((f) => f.endsWith('.json')).slice(-200)) {
            try {
                const saved = JSON.parse(readFileSync(join(RUN_DIR, file), 'utf8')) as Run;
                seen.set(saved.id, saved);
            } catch {
                // skip a damaged history file
            }
        }
    } catch {
        // no history yet
    }
    for (const run of runs.values()) seen.set(run.id, run);
    return [...seen.values()]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .map(({ id, kind, title, status, startedAt, environment }) => ({ id, kind, title, status, startedAt, environment }));
}

/**
 * What the browser sees (no working data, no client, the log only when asked) and, with keepWork, what the history
 * file keeps: each case's coded items and the few saved-patient fields a retry needs, so Retry failed works later too.
 */
export function publicRun(run: Run, withLog = false, keepWork = false) {
    const { context: _context, cases, log, ...rest } = run;
    const summary = summarize(run);
    return {
        ...rest,
        summary,
        cases: cases.map(({ savedPatient, performedItems, ...c }) => (keepWork ? { ...c, performedItems, savedPatient: retryFields(savedPatient) } : c)),
        log: withLog ? log : log.slice(-300),
    };
}

/** The saved-patient fields Create case reuses (pickPatientFields in case-flow.ts); the rest of the patient is not kept. */
function retryFields(saved: any): any {
    if (!saved || typeof saved !== 'object') return undefined;
    const keys = ['gender', 'primaryAccountNumber', 'fullName', 'fullNameWithTitle', 'fullNameWithTitlePrefixAsLastName', 'externalId', 'sourceIdentifier', 'accountNumbers', 'dateOfBirth'];
    return Object.fromEntries(keys.filter((k) => saved[k] !== undefined && saved[k] !== null).map((k) => [k, saved[k]]));
}

function summarize(run: Run) {
    if (run.kind !== 'cases') {
        return { done: run.items.length, ok: run.items.filter((i) => i.ok).length, failed: run.items.filter((i) => !i.ok).length, total: run.total };
    }
    const byTracker = Object.fromEntries(TRACKERS.map((t) => {
        const mine = run.cases.filter((c) => c.tracker === t.id);
        // Only when the tracker could be checked; otherwise the count is the ERAs posted, like every other tracker's.
        const inTracker = t.stage === 'remitted' && mine.some((c) => c.inTracker !== undefined) ? { inTracker: mine.filter((c) => c.inTracker).length } : {};
        return [t.id, { label: t.label, wanted: mine.length, reached: mine.filter((c) => !c.error && c.reached === c.target).length, failed: mine.filter((c) => c.error).length, ...inTracker }];
    }));
    const finished = run.cases.filter((c) => c.error || c.reached === c.target).length;
    return { done: finished, ok: run.cases.filter((c) => !c.error && c.reached === c.target).length, failed: run.cases.filter((c) => c.error).length, total: run.total, byTracker };
}

/** One row per case, ready for a spreadsheet or for manual testers to search by name. */
export function casesCsv(run: Run): string {
    const header = ['#', 'Tracker', 'First name', 'Last name', 'DOB', 'Patient ID', 'Case ID', 'Date of service', 'Target stage', 'Reached', 'Billing', 'Physician', 'Room', 'CPT codes', 'Insurances', 'Check/EFT number', 'ERA outcome', 'In Remittance Posting', 'Cancelled', 'Error'];
    const trackerLabel = (id: string) => TRACKERS.find((t) => t.id === id)?.label ?? id;
    const cell = (v: unknown) => {
        const text = v === undefined || v === null ? '' : String(v);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const rows = run.cases.map((c) => [c.index, trackerLabel(c.tracker), c.firstName, c.lastName, c.dateOfBirth, c.patientId, c.caseSummaryId, c.dateOfService, c.target, c.reached ?? 'nothing', c.selfPay ? 'Self pay' : 'Insurance', c.physician, c.room, c.cptCodes.join(' '), c.patientInsurances.map((i) => i.displayName).join(' | '), c.checkNumber, c.eraOutcome ? ERA_OUTCOMES[c.eraOutcome].label : '', c.inTracker === undefined ? '' : c.inTracker ? 'Yes' : 'Not yet', c.cancelled ? 'Yes' : '', c.error]);
    return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}


// #endregion

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CaseContext, CaseRecord, TrackerId } from './flows/case-flow.ts';
import type { CarrierSetup } from './flows/insurance.ts';
import type { PeriodBatch } from './flows/period-batch.ts';
import type { Lookups, Option } from './lookups.ts';
import type { ApiLog, SisClient } from './sis-client.ts';
import { advanceCase, TRACKERS } from './flows/case-flow.ts';
import { createCarrier } from './flows/insurance.ts';
import { createPeriodBatch } from './flows/period-batch.ts';
import { cleanSuffix, errorMessage, patientName, pool, randomDob, randomTag, todayYmd } from './util.ts';

const RUN_DIR = join(import.meta.dirname, '..', 'runs');
const LOG_LIMIT = 3000;

export type RunKind = 'cases' | 'periodBatches';

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
    log: ApiLog[];
    stopRequested?: boolean;
    /** Kept so failed cases can be retried with the same picks; not persisted. */
    context?: CaseContext;
    concurrency?: number;
};

const runs = new Map<string, Run>();

// #region Case runs

/** Turns the form into concrete picks, and says what is missing before anything is created. */
export function resolveCaseRun(req: CaseRunRequest, lookups: Lookups): { checks: Check[]; picks: Omit<CaseContext, 'client' | 'carriers' | 'periodBatch'> } {
    const choose = <T extends Option>(all: T[], ids?: number[]) => (ids?.length ? all.filter((o) => ids.includes(o.id)) : all);
    const rooms = lookups.rooms;
    const appointmentTypes = lookups.appointmentTypes;
    const physicians = choose(lookups.physicians, req.physicianIds);
    const procedures = lookups.feeSchedule;
    const count = (id: TrackerId) => Math.max(0, Number(req.trackers?.[id]) || 0);
    const total = TRACKERS.reduce((sum, t) => sum + count(t.id), 0);
    const needsCharge = TRACKERS.some((t) => t.stage === 'charged' && count(t.id) > 0);
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
    const { checks, picks } = resolveCaseRun(req, lookups);
    const failed = checks.filter((c) => !c.ok);
    if (failed.length) throw new Error(failed.map((c) => `${c.name}: ${c.detail}`).join('; '));

    const tag = cleanSuffix(req.suffix) || randomTag();
    const days = caseDates(req);
    const roomCount = lookups.rooms.length;
    const insuranceCount = Math.max(0, Math.min(Number(req.insuranceCount) || 0, 3));
    const cases: CaseRecord[] = [];
    for (const tracker of TRACKERS) {
        const selfPay = tracker.billing === 'selfPay' || (tracker.billing === 'either' && insuranceCount === 0);
        for (let i = 0; i < (Number(req.trackers?.[tracker.id]) || 0); i += 1) {
            const index = cases.length;
            const name = patientName(index, tag);
            cases.push({
                // Day first, then room, then the next 15-minute slot: no two cases share a room at the same time.
                index: index + 1, ...name, dateOfBirth: randomDob(), dateOfService: days[index % days.length],
                roomIndex: Math.floor(index / days.length) % roomCount, slot: Math.floor(index / (days.length * roomCount)),
                tracker: tracker.id, target: tracker.stage, selfPay, reached: null, patientInsurances: [], cptCodes: [], steps: [],
            });
        }
    }
    const run = newRun(base, 'cases', `${cases.length} clinical case(s)`, tag, cases.length);
    const client = runClient(base, run);
    run.cases = cases;
    run.concurrency = Math.max(1, Math.min(Number(req.concurrency) || 4, 10));
    void (async () => {
        try {
            const carriers: CarrierSetup[] = [];
            const carrierCount = cases.some((c) => !c.selfPay) ? Math.max(1, insuranceCount) : 0;
            for (let i = 1; i <= carrierCount; i += 1) {
                carriers.push(await createCarrier(client, `Ins${tag}${['P', 'S', 'T'][i - 1]}`));
            }
            run.setup.carriers = carriers;
            if (carriers.length) run.setup.notes.push(`Created ${carriers.map((c) => c.carrierName).join(', ')} and attached them to every insured patient.`);
            const selfPayCount = cases.filter((c) => c.selfPay).length;
            if (selfPayCount) run.setup.notes.push(`${selfPayCount} case(s) are self pay (no insurance), so the patient owes the balance.`);
            run.setup.periodBatch = await periodBatchFor(client, req, lookups, tag, days[0], cases.some((c) => c.target === 'charged'));
            if (run.setup.periodBatch) run.setup.notes.push(`Charges go to ${run.setup.periodBatch.periodName} / ${run.setup.periodBatch.batchDescription}.`);
            run.context = { client, ...picks, carriers, periodBatch: run.setup.periodBatch };
            await pool(cases, run.concurrency!, (rec) => advanceCase(run.context!, rec), () => !!run.stopRequested);
            finish(run);
        } catch (err) {
            finish(run, `Run setup failed: ${errorMessage(err)}`);
        }
    })();
    return run;
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

/** Runs the failed cases of a finished run again, each from the step it stopped at. */
export function retryFailed(run: Run): number {
    if (run.status === 'running') throw new Error('the run is still going');
    if (!run.context) throw new Error('this run was loaded from history; start a new run instead');
    const failed = run.cases.filter((c) => c.error);
    if (!failed.length) return 0;
    run.status = 'running';
    run.stopRequested = false;
    run.finishedAt = undefined;
    run.error = undefined;
    void (async () => {
        await pool(failed, run.concurrency ?? 4, (rec) => advanceCase(run.context!, rec), () => !!run.stopRequested);
        finish(run);
    })();
    return failed.length;
}

// #endregion

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
    try {
        mkdirSync(RUN_DIR, { recursive: true });
        writeFileSync(join(RUN_DIR, `${run.id}.json`), JSON.stringify(publicRun(run, true), null, 2));
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

/** What the browser and the history file see: no working data, no client, and the log only when asked. */
export function publicRun(run: Run, withLog = false) {
    const { context: _context, cases, log, ...rest } = run;
    const summary = summarize(run);
    return {
        ...rest,
        summary,
        cases: cases.map(({ savedPatient: _p, performedItems: _i, ...c }) => c),
        log: withLog ? log : log.slice(-300),
    };
}

function summarize(run: Run) {
    if (run.kind !== 'cases') {
        return { done: run.items.length, ok: run.items.filter((i) => i.ok).length, failed: run.items.filter((i) => !i.ok).length, total: run.total };
    }
    const byTracker = Object.fromEntries(TRACKERS.map((t) => {
        const mine = run.cases.filter((c) => c.tracker === t.id);
        return [t.id, { label: t.label, wanted: mine.length, reached: mine.filter((c) => !c.error && c.reached === c.target).length, failed: mine.filter((c) => c.error).length }];
    }));
    const finished = run.cases.filter((c) => c.error || c.reached === c.target).length;
    return { done: finished, ok: run.cases.filter((c) => !c.error && c.reached === c.target).length, failed: run.cases.filter((c) => c.error).length, total: run.total, byTracker };
}

/** One row per case, ready for a spreadsheet or for manual testers to search by name. */
export function casesCsv(run: Run): string {
    const header = ['#', 'Tracker', 'First name', 'Last name', 'DOB', 'Patient ID', 'Case ID', 'Date of service', 'Target stage', 'Reached', 'Billing', 'Physician', 'Room', 'CPT codes', 'Insurances', 'Error'];
    const trackerLabel = (id: string) => TRACKERS.find((t) => t.id === id)?.label ?? id;
    const cell = (v: unknown) => {
        const text = v === undefined || v === null ? '' : String(v);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const rows = run.cases.map((c) => [c.index, trackerLabel(c.tracker), c.firstName, c.lastName, c.dateOfBirth, c.patientId, c.caseSummaryId, c.dateOfService, c.target, c.reached ?? 'nothing', c.selfPay ? 'Self pay' : 'Insurance', c.physician, c.room, c.cptCodes.join(' '), c.patientInsurances.map((i) => i.displayName).join(' | '), c.error]);
    return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}


// #endregion

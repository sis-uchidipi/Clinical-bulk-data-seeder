import type { SisClient } from '../sis-client.ts';
import { firstNumber, ZERO_GUID } from '../util.ts';

/** The period/batch charges are posted into; Charge Entry lists a patient only under a batch one of its charges uses. */
export type PeriodBatch = {
    periodId: number;
    periodName: string;
    batchId: number;
    batchDescription: string;
};

function monthBounds(ymd: string) {
    const [y, m] = ymd.split('-').map(Number);
    return { begin: new Date(Date.UTC(y, m - 1, 1)).toISOString(), end: new Date(Date.UTC(y, m, 0, 23, 59, 59)).toISOString() };
}

/** A new open period covering the month of `ymd`, with one batch in it (PeriodConfig + PeriodBatch saves). */
export async function createPeriodBatch(client: SisClient, name: string, ymd: string): Promise<PeriodBatch> {
    const { begin, end } = monthBounds(ymd);
    const now = new Date().toISOString();
    const periodName = `Period${name}`;
    const batchDescription = `Batch${name}`;
    const period = await client.post('PeriodConfig/UpsertCheckedPeriodObject', {
        periodId: 0, organizationId: client.session.organizationId, periodName, periodCreatedDate: now, periodClosedDate: null,
        periodCreatorUsrId: 0, openedBy: client.session.username, closedBy: null, periodCloserUsrId: null,
        periodBeginDate: begin, periodEndDate: end, isReadOnlyPeriodBatch: false, resetClosedPeriodBatch: false, moduleId: 2030, sourceIdentifier: ZERO_GUID,
    });
    const periodId = firstNumber(period?.periodId, period?.result?.periodId, period?.id) ?? (await findPeriod(client, periodName))?.periodId;
    if (!periodId) throw new Error(`period ${periodName} was saved but its id was not found`);

    const batch = await client.post('PeriodBatch/InsertBatch', {
        batchId: 0, periodId, batchDescription, batchCreatedDate: now, batchClosedDate: null, batchCreatorUsrId: 0, batchCloserUsrId: null,
        batchBeginDate: begin, batchEndDate: end, isActive: true, openCases: 0, sourceIdentifier: ZERO_GUID,
    }, { contentType: 'text/json' });
    const batchId = firstNumber(batch?.batchId, batch?.result?.batchId, batch?.id)
        ?? (await findPeriod(client, periodName))?.batches?.find((b: any) => b.batchDescription === batchDescription)?.batchId;
    if (!batchId) throw new Error(`batch ${batchDescription} was saved but its id was not found`);
    return { periodId, periodName, batchId, batchDescription };
}

async function findPeriod(client: SisClient, periodName: string): Promise<any> {
    const list = await client.get('PeriodBatch/GetPeriodBatch/false');
    return (Array.isArray(list) ? list : []).find((p: any) => (p.periodName ?? p.label) === periodName);
}

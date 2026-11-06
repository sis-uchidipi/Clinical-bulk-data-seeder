import type { SisClient } from '../sis-client.ts';
import { firstNumber, sleep } from '../util.ts';

export type CreatedItem = { name: string; id?: number; ok: boolean; error?: string };

// #region Transaction codes

export const TRANSACTION_CODE_TYPES = ['Allocation', 'Correction', 'Debit', 'Payment', 'Transfer', 'Unassigned Payment', 'Write-Off'] as const;

export type TransactionCodeInput = { name: string; type: string; toDebit?: number; toCredit?: number };

/** Application Settings → Transaction Codes save. */
export async function createTransactionCode(client: SisClient, input: TransactionCodeInput): Promise<number | undefined> {
    const payload: Record<string, unknown> = { transactionCodeName: input.name, type: input.type };
    if (input.toDebit) payload.toDebit = input.toDebit;
    if (input.toCredit) payload.toCredit = input.toCredit;
    const saved = await client.post('facility/business/transaction-codes', payload);
    return firstNumber(saved?.transactionCodeId, saved?.id);
}

// #endregion

// #region Contracts

export const CONTRACT_TYPES = ['% of Billed Charges', 'Contract Fee Schedule', 'Grouper'] as const;

export type ContractInput = {
    name: string;
    type: string;
    effectiveDate: string;
    expirationDate: string;
    /** % of billed charges (or % of allowed for a fee-schedule contract). */
    percent?: number;
    notes?: string;
};

/** "At Charge Posting": the adjustment time the Contracts screen defaults to. */
const ADJUSTMENT_AT_CHARGE_POSTING = { adjustmentTimeId: 16297, adjustmentTimeString: 'At Charge Posting' };

/**
 * Contract header save, then (for the two percentage types) its posting option and a recalculation of the review list,
 * which is what the Contracts screen does on Save. A Grouper contract has no posting option.
 */
export async function createContract(client: SisClient, input: ContractInput): Promise<number> {
    const saved = await client.put('facility/business/contracts', {
        insuranceContractId: 0,
        insuranceContractName: input.name,
        isHybridContract: false,
        effectiveDate: input.effectiveDate,
        expirationDate: input.expirationDate,
        notes: input.notes ?? '',
    });
    const contractId = firstNumber(saved?.insuranceContractId, saved?.insuranceContractObjectId, saved?.id);
    if (!contractId) throw new Error('the contract was saved but the answer had no insuranceContractId');
    if (input.type === 'Grouper') return contractId;

    await client.delete(`facility/business/contracts/posting-options/${contractId}`, { retries: 0 }).catch(() => undefined);
    await client.put('facility/business/contracts/posting-option', {
        postingOption: 1,
        insuranceContractId: contractId,
        ...ADJUSTMENT_AT_CHARGE_POSTING,
        ...(input.percent !== undefined ? { percentOfBilledCharge: input.percent } : {}),
    });
    await client.post('facility/business/contracts/review-list/recalculate', { insuranceContractId: contractId, pageNumber: 1, rowsPerPage: 1, filterText: '' });
    return contractId;
}

// #endregion

// #region Case flags

export const CASE_FLAG_VISIBILITY: Record<string, number> = { Clinical: 1, Business: 2, Both: 3 };

/** RecordLockType of the facility's Case Flagging Configuration; a Config save without it is refused. */
const CASE_FLAG_LOCK_TYPE = 27;

export type CaseFlagInput = { name: string; abbreviation: string; color: string; visibility: string };

export async function caseFlagColors(client: SisClient): Promise<{ caseFlagColorId: number; name: string }[]> {
    const colors = await client.get('CaseFlag/Colors');
    return Array.isArray(colors) ? colors : [];
}

/**
 * Creates case flags under the facility's Case Flagging Configuration lock (requested with backoff while another
 * session holds it, always released). A flag whose name already exists is reported, not duplicated.
 */
export async function createCaseFlags(client: SisClient, inputs: CaseFlagInput[], onItem: (item: CreatedItem) => void, shouldStop: () => boolean): Promise<void> {
    const colors = await caseFlagColors(client);
    if (!colors.length) throw new Error('CaseFlag/Colors returned no colors: is Case Flagging turned on for this facility?');
    const organizationId = client.session.organizationId;
    const lock = { recordLockTypeId: CASE_FLAG_LOCK_TYPE, organizationId };

    await requestLock(client, lock);
    try {
        const existing: any[] = (await client.get('CaseFlag/Config')) ?? [];
        for (const input of inputs) {
            if (shouldStop()) return;
            const color = colors.find((c) => c.name.toLowerCase() === input.color.toLowerCase()) ?? colors[0];
            if (existing.some((f) => f.caseFlagName === input.name)) {
                onItem({ name: input.name, ok: false, error: 'a flag with this name already exists' });
                continue;
            }
            try {
                const saved = await client.post('CaseFlag/Config', {
                    caseFlagId: 0, caseFlagName: input.name, abbreviation: input.abbreviation.slice(0, 2).toUpperCase(),
                    caseFlagColorId: color.caseFlagColorId, caseFlagColor: color, caseFlagVisibility: CASE_FLAG_VISIBILITY[input.visibility] ?? 3,
                    activeTf: true, organizationId,
                });
                onItem({ name: input.name, id: firstNumber(saved?.caseFlagId), ok: true });
            } catch (err) {
                onItem({ name: input.name, ok: false, error: (err as Error).message });
            }
        }
    } finally {
        await client.post('Security/RecordLock/ReleaseLock', lock, { retries: 0 }).catch(() => undefined);
    }
}

/** RequestLock answers with the staff member holding the lock, or nothing when the lock is ours. */
async function requestLock(client: SisClient, lock: object): Promise<void> {
    const waits = [500, 1000, 2000, 4000, 4000, 4000, 4000, 4000, 4000];
    for (const wait of waits) {
        const heldBy = await client.post('Security/RecordLock/RequestLock', lock);
        if (!heldBy?.staffName) return;
        await sleep(wait);
    }
    throw new Error('the Case Flagging configuration stayed locked by another user for 30s');
}

// #endregion

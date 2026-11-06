import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
export const TEMPLATE_DIR = join(import.meta.dirname, '..', 'templates');

const templateCache = new Map<string, unknown>();

/** A deep copy of a captured request template, so callers can change it freely. */
export function template(name: string): any {
    if (!templateCache.has(name)) {
        templateCache.set(name, JSON.parse(readFileSync(join(TEMPLATE_DIR, name), 'utf8')));
    }
    return structuredClone(templateCache.get(name));
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function pick<T>(list: T[]): T {
    return list[Math.floor(Math.random() * list.length)];
}

export function firstNumber(...values: unknown[]): number | undefined {
    for (const value of values) {
        const num = Number(value);
        if (value !== null && value !== undefined && value !== '' && Number.isFinite(num) && num > 0) return num;
    }
    return undefined;
}

export function firstString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
}

/** Letters and digits only: suffixes end up in patient names, which the app validates. */
export function cleanSuffix(raw: unknown): string {
    return String(raw ?? '').replace(/[^0-9a-zA-Z]/g, '').slice(0, 20);
}

export function randomTag(length = 5): string {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    return Array.from({ length }, () => pick([...letters])).join('');
}

const FIRST_NAMES = ['Avery', 'Blake', 'Casey', 'Dana', 'Emery', 'Finley', 'Gray', 'Harper', 'Indy', 'Jordan', 'Kendall', 'Logan', 'Morgan', 'Noel', 'Oakley', 'Parker', 'Quinn', 'Reese', 'Sawyer', 'Taylor', 'Uma', 'Val', 'Wren', 'Yael', 'Zion'];
const LAST_NAMES = ['Abbott', 'Barlow', 'Carver', 'Dempsey', 'Ellison', 'Fairbanks', 'Garrison', 'Holloway', 'Irving', 'Jessup', 'Kendrick', 'Lockhart', 'Merritt', 'Norwood', 'Oakes', 'Prentice', 'Quimby', 'Radcliffe', 'Sinclair', 'Thornton', 'Underwood', 'Vickers', 'Whitlock', 'Yardley', 'Zimmer'];

/**
 * Patient names that never collide with an existing patient: GetDuplicatePatients would otherwise hand back that
 * patient and the case would be added to someone else's chart. The run tag keeps every record traceable.
 */
export function patientName(index: number, runTag: string): { firstName: string; lastName: string } {
    const letters = index.toString(26).split('').map((d) => String.fromCharCode(65 + parseInt(d, 26))).join('');
    return { firstName: `${pick(FIRST_NAMES)}${letters}`, lastName: `${pick(LAST_NAMES)}${runTag}` };
}

export function randomDob(): string {
    const year = 1945 + Math.floor(Math.random() * 60);
    const month = 1 + Math.floor(Math.random() * 12);
    const day = 1 + Math.floor(Math.random() * 28);
    return `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`;
}

export function todayYmd(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** A 15-minute slot on the given day between 07:00 and 17:45 (UTC, the way the Create Case payload stores it). */
export function caseSlot(ymd: string, slotIndex: number) {
    const minutes = 7 * 60 + (slotIndex % 44) * 15;
    const start = new Date(`${ymd}T00:00:00Z`);
    start.setUTCMinutes(minutes);
    const stop = new Date(start.getTime() + 15 * 60_000);
    const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    const [y, m, d] = ymd.split('-');
    return { startIso: start.toISOString(), stopIso: stop.toISOString(), startHHmm: hhmm(start), stopHHmm: hhmm(stop), dateOfService: `${m}/${d}/${y}` };
}

/** Runs `worker` over `items` with at most `limit` in flight; stops picking new items once `shouldStop` says so. */
export async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>, shouldStop: () => boolean): Promise<void> {
    let next = 0;
    const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while (next < items.length && !shouldStop()) {
            const item = items[next];
            next += 1;
            await worker(item);
        }
    });
    await Promise.all(lanes);
}

export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

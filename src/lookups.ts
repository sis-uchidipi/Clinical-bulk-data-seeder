import type { SisClient } from './sis-client.ts';
import { errorMessage, firstNumber, firstString } from './util.ts';

export type Option = { id: number; name: string };
export type FeeScheduleItem = Option & { cptCode: string; amount?: number; raw: any };
export type PeriodOption = Option & { batches: Option[] };

export type Lookups = {
    rooms: Option[];
    appointmentTypes: Option[];
    physicians: Option[];
    feeSchedule: FeeScheduleItem[];
    periods: PeriodOption[];
    /** Lookups that failed, by name, so the UI can say which list is missing and why. */
    errors: Record<string, string>;
};

function asList(data: any): any[] {
    if (Array.isArray(data)) return data;
    for (const key of ['result', 'data', 'items', 'rooms', 'periods']) {
        if (Array.isArray(data?.[key])) return data[key];
    }
    return [];
}

function options(data: any, idOf: (x: any) => unknown, nameOf: (x: any) => unknown): Option[] {
    return asList(data)
        .map((x) => ({ id: firstNumber(idOf(x)) ?? 0, name: firstString(nameOf(x)) ?? '' }))
        .filter((o) => o.id > 0 && o.name);
}

const PHYSICIAN_ROLE = /physician|surgeon|doctor|provider|anesthesiologist|\bmd\b|\bdr\b/i;

/** Staff come back with mixed roles; only physicians belong on a case (Cases to Code joins on primaryPhysicianId). */
function physicians(data: any): Option[] {
    const staff = asList(data);
    const roleText = (s: any) => [s.roleName, s.role, s.roleDescription, s.staffType, s.staffRole, s.title, s.personType, s.roles?.map?.((r: any) => r?.roleName ?? r).join(' ')].filter(Boolean).join(' ');
    const byRole = staff.filter((s) => PHYSICIAN_ROLE.test(roleText(s)));
    const chosen = byRole.length ? byRole : staff;
    return options(chosen, (s) => s.personId ?? s.PersonId ?? s.staffId ?? s.id, (s) => s.fullName ?? s.FullName ?? s.name ?? `${s.lastName ?? ''}, ${s.firstName ?? ''}`.replace(/^, |, $/, ''));
}

function feeSchedule(data: any): FeeScheduleItem[] {
    return asList(data)
        .filter((f) => f && (f.activeTf ?? true) && f.cptProcedure?.cptCode)
        .map((f) => ({
            id: Number(f.feeScheduleId),
            name: `${f.cptProcedure.cptCode} — ${f.procedure ?? f.cptProcedure.cptDescription ?? ''}`.trim(),
            cptCode: String(f.cptProcedure.cptCode),
            amount: typeof f.amount === 'number' ? f.amount : undefined,
            raw: f,
        }))
        .filter((f) => f.id > 0);
}

function periods(data: any): PeriodOption[] {
    return asList(data)
        .map((p) => ({
            id: firstNumber(p.periodId, p.value) ?? 0,
            name: firstString(p.label, p.periodName) ?? `Period ${p.periodId}`,
            batches: options(p.batches, (b) => b.batchId ?? b.id, (b) => b.batchDescription ?? b.label),
        }))
        .filter((p) => p.id > 0 && p.batches.length > 0);
}

/** Everything the forms offer, loaded in parallel. One list failing never hides the others. */
export async function loadLookups(client: SisClient): Promise<Lookups> {
    const orgId = client.session.organizationId;
    const errors: Record<string, string> = {};
    const safe = async <T>(name: string, load: () => Promise<T>, empty: T): Promise<T> => {
        try {
            return await load();
        } catch (err) {
            errors[name] = errorMessage(err);
            return empty;
        }
    };
    const [rooms, appointmentTypes, staff, fees, periodList] = await Promise.all([
        safe('rooms', () => client.get('Room/GetRoomsForOrganization'), []),
        safe('appointmentTypes', () => client.get('ApptypeCasepackMap/GetApptypeCasepackMapData'), []),
        safe('physicians', () => client.get(`StaffList/GetStaffForOrganization/${orgId}/false`), []),
        safe('feeSchedule', () => client.get('FeeSchedule/GetFeeSchedules/'), []),
        safe('periods', () => client.get('PeriodBatch/GetPeriodBatch/false'), []),
    ]);
    return {
        rooms: options(asList(rooms).filter((r) => r.activeTf !== false && r.isActive !== false), (r) => r.roomId ?? r.RoomId ?? r.id, (r) => r.name ?? r.roomName ?? r.displayName),
        appointmentTypes: dedupe(options(appointmentTypes, (a) => a.appointmentTypeId ?? a.AppointmentTypeId ?? a.id, (a) => a.appointment_Type_Desc ?? a.appTypeDesc ?? a.description ?? a.name)),
        physicians: physicians(staff),
        feeSchedule: feeSchedule(fees),
        periods: periods(periodList),
        errors,
    };
}

function dedupe(list: Option[]): Option[] {
    const seen = new Set<number>();
    return list.filter((o) => !seen.has(o.id) && seen.add(o.id));
}

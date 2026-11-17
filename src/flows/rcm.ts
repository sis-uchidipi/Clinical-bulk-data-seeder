import type { SisClient } from '../sis-client.ts';
import { ApiError } from '../sis-client.ts';

/**
 * Revenue Cycle Management tracker. A charged account is listed only once its RCM template's "Days From Post/Transfer"
 * have passed (14 by default), so a new case would show two weeks later. The automation repo's RCM tests (e.g. TC
 * 379971) set the templates their cases fall under to 0 days first; this does the same through the app's own calls:
 * RCMConfig/GetConfigs + RCMConfig/UpsertConfig, or facility/business/rcm-config when Business Office Granular
 * Permissions (247) is on. Every change keeps the value it replaced, so a run can restore it.
 */
const BUSINESS_GRANULAR_FEATURE_ID = 247;
/** The classification of the carriers this seeder creates (templates/saveInsuranceCarrier.json). */
export const SEEDED_CARRIER_CLASSIFICATION = 'Champus';
const SELF_PAY_TEMPLATES = /self[\s-]*pay|patient\s+responsibility/i;

export type RcmTemplate = { id: number; name: string; classifications: string[]; days: string; raw: any };
export type RcmTemplateChange = { id: number; name: string; before: string; after: string };

async function businessGranular(client: SisClient): Promise<boolean> {
    try {
        const states = await client.get('v2/feature/states/all', { retries: 1 });
        return !!(states && typeof states === 'object' && states[String(BUSINESS_GRANULAR_FEATURE_ID)]);
    } catch {
        return false;
    }
}

const configRoute = (granular: boolean, legacy: string) => (granular ? 'facility/business/rcm-config' : legacy);

export async function readRcmTemplates(client: SisClient): Promise<{ granular: boolean; templates: RcmTemplate[] }> {
    const granular = await businessGranular(client);
    const answer = await client.get(configRoute(granular, 'RCMConfig/GetConfigs'));
    const rows: any[] = Array.isArray(answer) ? answer : answer?.result ?? answer?.data ?? answer?.items ?? [];
    const templates = rows.map((raw) => ({
        id: Number(raw.id ?? raw.rcmConfigId),
        name: String(raw.name ?? raw.templateName ?? ''),
        classifications: Array.isArray(raw.classifications) ? raw.classifications.map(String) : [],
        days: String(raw.days ?? raw.daysFromPostOrTransfer ?? ''),
        raw,
    })).filter((t) => Number.isFinite(t.id) && t.name);
    return { granular, templates };
}

/** The templates the run's cases fall under: the seeded carriers' classification, and the self-pay ones. */
export function templatesFor(templates: RcmTemplate[], insured: boolean, selfPay: boolean): RcmTemplate[] {
    return templates.filter((t) => (insured && t.classifications.some((c) => c.toLowerCase() === SEEDED_CARRIER_CLASSIFICATION.toLowerCase()))
        || (selfPay && SELF_PAY_TEMPLATES.test(t.name)));
}

/** Sets one template's days (the template row as read, with only the days changed). */
export async function setTemplateDays(client: SisClient, granular: boolean, template: RcmTemplate, days: string): Promise<void> {
    try {
        await client.post(configRoute(granular, 'RCMConfig/UpsertConfig'), { ...template.raw, days });
    } catch (err) {
        const refused = err instanceof ApiError && err.status === 403;
        throw new Error(`${template.name}: ${refused ? 'this sign-in may not change RCM templates (Business Office settings permission)' : (err as Error).message}`);
    }
}

/**
 * Sets the run's templates to 0 days where they are not already, so its charged cases are listed today. Returns what
 * was changed (with the old values) and the templates that were missing, so the run can say why a case may not show.
 */
export async function openRcmTemplates(client: SisClient, insured: boolean, selfPay: boolean): Promise<{ changes: RcmTemplateChange[]; matched: RcmTemplate[] }> {
    const { granular, templates } = await readRcmTemplates(client);
    const matched = templatesFor(templates, insured, selfPay);
    const changes: RcmTemplateChange[] = [];
    for (const template of matched) {
        if (Number(template.days) === 0) continue;
        await setTemplateDays(client, granular, template, '0');
        changes.push({ id: template.id, name: template.name, before: template.days, after: '0' });
    }
    return { changes, matched };
}

/** Puts back the days a run changed; templates changed again since then are still set back to the recorded value. */
export async function restoreRcmTemplates(client: SisClient, changes: RcmTemplateChange[]): Promise<string[]> {
    const { granular, templates } = await readRcmTemplates(client);
    const done: string[] = [];
    for (const change of changes) {
        const template = templates.find((t) => t.id === change.id);
        if (!template) throw new Error(`RCM template ${change.name} (${change.id}) no longer exists`);
        await setTemplateDays(client, granular, template, change.before);
        done.push(`${change.name}: ${change.after} → ${change.before} days`);
    }
    return done;
}

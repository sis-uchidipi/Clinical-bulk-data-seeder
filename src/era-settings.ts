import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Where the ERA app values come from when neither the shell nor `.env` sets them: the SIS automation repo checkout on
 * this machine, which already holds them for its own electronic remittance seeding. They are read into this process
 * only; nothing is copied into this (public) repository, written to disk or printed.
 */
const SEED_FILE = 'playwright/app-modules-libs/sis-complete/shared/seed/cbo-remittance-posting.seed.ts';
const ROUTES_FILE = 'playwright/support/common-core-libs/application/constants/sub-routes.constants.ts';
const REPO_NAMES = ['SISDomainsAutomation', 'SISDomainAutomation'];

export type EraSource = { from: 'environment' | 'automation repo' | 'none'; path?: string };

/** Fills SIS_ERA_* from the automation repo when they are not set. Returns where the values came from. */
export function loadEraFromAutomationRepo(): EraSource {
    if (['SIS_ERA_TENANT_ID', 'SIS_ERA_CLIENT_ID', 'SIS_ERA_CLIENT_SECRET'].every((key) => process.env[key]?.trim())) {
        return { from: 'environment' };
    }
    for (const repo of candidateRepos()) {
        const values = readValues(repo);
        if (!values) continue;
        process.env.SIS_ERA_TENANT_ID ||= values.tenantId;
        process.env.SIS_ERA_CLIENT_ID ||= values.clientId;
        process.env.SIS_ERA_CLIENT_SECRET ||= values.clientSecret;
        return { from: 'automation repo', path: repo };
    }
    return { from: 'none' };
}

/** SIS_AUTOMATION_REPO when set, else an automation checkout next to this one (e.g. repo/SISDomainsAutomation). */
function candidateRepos(): string[] {
    const parent = resolve(import.meta.dirname, '..', '..');
    const configured = process.env.SIS_AUTOMATION_REPO?.trim();
    return [...(configured ? [resolve(configured)] : []), ...REPO_NAMES.map((name) => join(parent, name))]
        .filter((path) => existsSync(join(path, SEED_FILE)) && existsSync(join(path, ROUTES_FILE)));
}

/**
 * The "API to API" app of the seed's getTokenForElectronicData: the client id and secret sent with the
 * get_api2api_token request, and the tenant in that route's URL.
 */
function readValues(repo: string): { tenantId: string; clientId: string; clientSecret: string } | undefined {
    try {
        const routes = readFileSync(join(repo, ROUTES_FILE), 'utf8');
        const seed = readFileSync(join(repo, SEED_FILE), 'utf8');
        const tenantId = /get_api2api_token\s*=\s*'https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\//i.exec(routes)?.[1];
        const tokenCall = seed.slice(seed.indexOf('url: SubRoutes.get_api2api_token'));
        const clientId = /client_id:\s*'([^']+)'/.exec(tokenCall)?.[1];
        const clientSecret = /client_secret:\s*'([^']+)'/.exec(tokenCall)?.[1];
        return tenantId && clientId && clientSecret ? { tenantId, clientId, clientSecret } : undefined;
    } catch {
        return undefined;
    }
}

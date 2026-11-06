import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';

import type { Lookups } from './lookups.ts';
import type { CaseRunRequest, ConfigRunRequest, RunKind } from './runs.ts';
import { TRACKERS } from './flows/case-flow.ts';
import { CONTRACT_TYPES, TRANSACTION_CODE_TYPES, caseFlagColors } from './flows/config-data.ts';
import { loadLookups } from './lookups.ts';
import { casesCsv, getRun, listRuns, publicRun, resolveCaseRun, retryFailed, startCaseRun, startConfigRun, stopRun } from './runs.ts';
import { SisClient } from './sis-client.ts';
import { errorMessage } from './util.ts';

const PORT = Number(process.env.PORT) || 4100;
/** Local only by default: the server holds live session tokens. Set HOST=0.0.0.0 to share it on purpose. */
const HOST = process.env.HOST || '127.0.0.1';
const UI_DIR = join(import.meta.dirname, '..', 'ui');
const SESSION_IDLE_MS = 8 * 60 * 60_000;

type Session = { client: SisClient; lookups?: Lookups; lastUsed: number };
const sessions = new Map<string, Session>();

class HttpError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

// #region Plumbing

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const isText = typeof body === 'string';
    res.writeHead(status, { 'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(isText ? body : JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 1_000_000) throw new HttpError(413, 'request too large');
        chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try {
        return (text ? JSON.parse(text) : {}) as T;
    } catch {
        throw new HttpError(400, 'body is not valid JSON');
    }
}

function sessionId(req: IncomingMessage): string | undefined {
    return /(?:^|;\s*)sid=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
}

function requireSession(req: IncomingMessage): Session {
    const session = sessions.get(sessionId(req) ?? '');
    if (!session) throw new HttpError(401, 'not signed in');
    session.lastUsed = Date.now();
    return session;
}

async function lookupsOf(session: Session, refresh = false): Promise<Lookups> {
    if (!session.lookups || refresh) session.lookups = await loadLookups(session.client);
    return session.lookups;
}

const STATIC_TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serveStatic(res: ServerResponse, path: string): void {
    const file = path === '/' ? 'index.html' : path.slice(1);
    // ui/ files, and ui/assets/ images: nothing else, and no way out of ui/.
    if (!/^(assets\/)?[\w.-]+$/.test(file) || file.includes('..') || !STATIC_TYPES[extname(file)]) return send(res, 404, 'not found');
    try {
        res.writeHead(200, { 'Content-Type': STATIC_TYPES[extname(file)], 'Cache-Control': 'no-cache' });
        res.end(readFileSync(join(UI_DIR, file)));
    } catch {
        send(res, 404, 'not found');
    }
}

// #endregion

// #region Routes

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], query: URLSearchParams) => Promise<void>;

const routes: [string, RegExp, Handler][] = [
    ['POST', /^\/api\/login$/, async (req, res) => {
        const body = await readJson<{ apiUrl?: string; organizationId?: number; username?: string; password?: string }>(req);
        const organizationId = Number(body.organizationId);
        if (!body.apiUrl || !body.username || !body.password || !organizationId) throw new HttpError(400, 'API URL, facility id, username and password are all required');
        const client = await SisClient.login(body.apiUrl, body.username, body.password, organizationId);
        const id = randomUUID();
        const session: Session = { client, lastUsed: Date.now() };
        sessions.set(id, session);
        const lookups = await lookupsOf(session);
        send(res, 200, { ...client.session, token: undefined, lookups: lookupSummary(lookups) }, { 'Set-Cookie': `sid=${id}; HttpOnly; SameSite=Strict; Path=/` });
    }],
    ['POST', /^\/api\/logout$/, async (req, res) => {
        const id = sessionId(req);
        if (id) sessions.delete(id);
        send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Max-Age=0; Path=/' });
    }],
    ['GET', /^\/api\/session$/, async (req, res) => {
        const session = requireSession(req);
        send(res, 200, { ...session.client.session, token: undefined });
    }],
    ['GET', /^\/api\/lookups$/, async (req, res, _p, query) => {
        const session = requireSession(req);
        const lookups = await lookupsOf(session, query.get('refresh') === '1');
        let colors: string[] = [];
        try {
            colors = (await caseFlagColors(session.client)).map((c) => c.name);
        } catch {
            // Case Flagging off for the facility: the Case Flags tab says so when used
        }
        send(res, 200, {
            ...lookups,
            feeSchedule: lookups.feeSchedule.map(({ raw: _raw, ...f }) => f),
            trackers: TRACKERS,
            transactionCodeTypes: TRANSACTION_CODE_TYPES,
            contractTypes: CONTRACT_TYPES,
            caseFlagColors: colors,
        });
    }],
    ['POST', /^\/api\/cases\/check$/, async (req, res) => {
        const session = requireSession(req);
        const body = await readJson<CaseRunRequest>(req);
        const { checks } = resolveCaseRun(body, await lookupsOf(session));
        send(res, 200, { checks });
    }],
    ['POST', /^\/api\/cases\/run$/, async (req, res) => {
        const session = requireSession(req);
        const run = startCaseRun(session.client, await readJson<CaseRunRequest>(req), await lookupsOf(session));
        send(res, 200, { id: run.id });
    }],
    ['POST', /^\/api\/(transactionCodes|contracts|caseFlags|periodBatches)\/run$/, async (req, res, [kind]) => {
        const session = requireSession(req);
        const run = startConfigRun(session.client, kind as Exclude<RunKind, 'cases'>, await readJson<ConfigRunRequest>(req), await lookupsOf(session));
        send(res, 200, { id: run.id });
    }],
    ['GET', /^\/api\/runs$/, async (req, res) => {
        requireSession(req);
        send(res, 200, listRuns());
    }],
    ['GET', /^\/api\/runs\/([\w-]+)$/, async (req, res, [id]) => {
        requireSession(req);
        const run = getRun(id);
        if (!run) throw new HttpError(404, 'no such run');
        send(res, 200, publicRun(run));
    }],
    ['GET', /^\/api\/runs\/([\w-]+)\/log$/, async (req, res, [id]) => {
        requireSession(req);
        const run = getRun(id);
        if (!run) throw new HttpError(404, 'no such run');
        send(res, 200, run.log);
    }],
    ['GET', /^\/api\/runs\/([\w-]+)\/cases\.csv$/, async (req, res, [id]) => {
        requireSession(req);
        const run = getRun(id);
        if (!run) throw new HttpError(404, 'no such run');
        send(res, 200, casesCsv(run), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${id}.csv"` });
    }],
    ['POST', /^\/api\/runs\/([\w-]+)\/stop$/, async (req, res, [id]) => {
        requireSession(req);
        stopRun(id);
        send(res, 200, { ok: true });
    }],
    ['POST', /^\/api\/runs\/([\w-]+)\/retry$/, async (req, res, [id]) => {
        requireSession(req);
        const run = getRun(id);
        if (!run) throw new HttpError(404, 'no such run');
        send(res, 200, { retried: retryFailed(run) });
    }],
];

function lookupSummary(l: Lookups) {
    return { rooms: l.rooms.length, appointmentTypes: l.appointmentTypes.length, physicians: l.physicians.length, procedures: l.feeSchedule.length, periods: l.periods.length, errors: l.errors };
}

// #endregion

const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
        if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
        for (const [method, pattern, handler] of routes) {
            const match = pattern.exec(url.pathname);
            if (match && method === req.method) return await handler(req, res, match.slice(1), url.searchParams);
        }
        throw new HttpError(404, 'unknown API route');
    } catch (err) {
        const status = err instanceof HttpError ? err.status : 502;
        if (!res.headersSent) send(res, status, { error: errorMessage(err) });
    }
});

setInterval(() => {
    for (const [id, s] of sessions) if (Date.now() - s.lastUsed > SESSION_IDLE_MS) sessions.delete(id);
}, 10 * 60_000).unref();

server.listen(PORT, HOST, () => {
    console.log(`Clinical Seeder is running: http://localhost:${PORT}/`);
});

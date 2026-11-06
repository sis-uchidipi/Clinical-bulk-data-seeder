import { sleep } from './util.ts';

export type ApiLog = {
    time: string;
    method: string;
    path: string;
    status: number | 'ERR';
    ms: number;
    error?: string;
};

export type RequestOptions = {
    /** Body as-is: a string is sent verbatim (UpdateCaseSatus takes a bare `10`), anything else as JSON. */
    body?: unknown;
    /** `text/json` is what the Gemini endpoints expect; the business-office endpoints take `application/json`. */
    contentType?: 'application/json' | 'text/json';
    timeoutMs?: number;
    /** Network errors, 429 and 5xx are retried this many times with backoff (default 2). */
    retries?: number;
};

/** An API answer that was not 2xx, with the server's own message so the run report can show why. */
export class ApiError extends Error {
    status: number;
    path: string;

    constructor(method: string, path: string, status: number, body: string) {
        super(`${method} ${path} → ${status}${body ? `: ${ApiError.summarize(body)}` : ''}`);
        this.status = status;
        this.path = path;
    }

    private static summarize(body: string): string {
        try {
            const parsed = JSON.parse(body);
            const message = parsed?.message ?? parsed?.Message ?? parsed?.errorMessages?.join?.('; ') ?? parsed?.title ?? parsed?.ExceptionMessage;
            if (message) return String(message).slice(0, 300);
        } catch {
            // not JSON: fall through to the raw text
        }
        return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    }
}

export type Session = {
    apiUrl: string;
    token: string;
    organizationId: number;
    /** The facility's name as User/UserOrgMap lists it (e.g. Gem_Org022), when the map could be read. */
    organizationName?: string;
    username: string;
};

export type Facility = { organizationId: number; name: string };

/**
 * Thin HTTP client for the SIS Complete web API (`<apiUrl>/api/...`). Sends the session token the way the web app does
 * (`token` + `ChartsApp` headers), retries transient failures, throws ApiError on any non-2xx, and reports every call
 * to `onLog` with the token never included.
 */
export class SisClient {
    readonly session: Session;
    private onLog: (entry: ApiLog) => void;

    constructor(session: Session, onLog: (entry: ApiLog) => void = () => undefined) {
        this.session = session;
        this.onLog = onLog;
    }

    /** The same session, reporting its calls somewhere else (each run keeps its own API log). */
    withLogger(onLog: (entry: ApiLog) => void): SisClient {
        return new SisClient(this.session, onLog);
    }

    static apiBase(apiUrl: string): string {
        const trimmed = apiUrl.trim().replace(/\/+$/, '');
        return trimmed.toLowerCase().endsWith('/api') ? trimmed : `${trimmed}/api`;
    }

    /**
     * Login/LoginUser, then UserSession/UserSessionOrg binds the session to the facility (every facility-scoped call
     * fails without it). The password is only used for this call and never kept.
     */
    static async login(apiUrl: string, username: string, password: string, organizationId: number, onLog?: (entry: ApiLog) => void): Promise<SisClient> {
        const anonymous = new SisClient({ apiUrl, token: '', organizationId, username }, onLog);
        const raw = await anonymous.request<unknown>('POST', 'Login/LoginUser', { body: { userName: username, password }, contentType: 'application/json', retries: 1 });
        const token = SisClient.parseToken(raw);
        if (!token) throw new Error('Login answered without a token: check the API URL (it must be the web service URL, not the app URL) and the credentials.');
        const client = new SisClient({ apiUrl, token, organizationId, username }, onLog);
        const facilities = await client.facilities();
        if (facilities.length) {
            const facility = facilities.find((f) => f.organizationId === organizationId);
            if (!facility) {
                const list = facilities.map((f) => `${f.name} (${f.organizationId})`).join(', ');
                throw new Error(`Facility ${organizationId} is not one of ${username}'s facilities on this environment. Available: ${list}`);
            }
            client.session.organizationName = facility.name;
        }
        await client.request('POST', `UserSession/UserSessionOrg/${organizationId}`, { body: {}, contentType: 'application/json' });
        return client;
    }

    /**
     * The facilities the signed-in user is mapped to (User/UserOrgMap: enterprise rows with their childOrgs). Empty when
     * the map can't be read, in which case the facility id is taken as typed.
     */
    async facilities(): Promise<Facility[]> {
        let map: unknown;
        try {
            map = await this.get('User/UserOrgMap', { retries: 1 });
        } catch (err) {
            console.warn(`Facility check skipped: User/UserOrgMap failed (${(err as Error).message})`);
            return [];
        }
        const found = new Map<number, string>();
        const walk = (node: any): void => {
            if (typeof node === 'string' && /^\s*[[{]/.test(node)) {
                try {
                    return walk(JSON.parse(node));
                } catch {
                    return;
                }
            }
            if (Array.isArray(node)) return node.forEach(walk);
            if (!node || typeof node !== 'object') return;
            const id = Number(node.organizationId ?? node.orgId ?? node.organizationID ?? node.OrganizationId);
            const name = node.name ?? node.organizationName ?? node.orgName ?? node.displayName ?? node.Name;
            if (Number.isFinite(id) && id > 0 && typeof name === 'string' && name.trim()) found.set(id, name.trim());
            for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
        };
        walk(map);
        if (!found.size) {
            const shape = Array.isArray(map) ? `array of ${map.length}` : typeof map;
            console.warn(`Facility check skipped: User/UserOrgMap answered with no organizations (${shape}${map && typeof map === 'object' ? `, keys: ${Object.keys(Array.isArray(map) ? map[0] ?? {} : map).slice(0, 12).join(', ')}` : ''})`);
        }
        return [...found].map(([organizationId, name]) => ({ organizationId, name })).sort((a, b) => a.name.localeCompare(b.name));
    }

    private static parseToken(raw: unknown): string | undefined {
        if (typeof raw === 'string') {
            const text = raw.trim();
            if (text.startsWith('<')) throw new Error('Login returned an HTML page (blocked by the firewall or wrong API URL).');
            try {
                return SisClient.parseToken(JSON.parse(text));
            } catch {
                return text.replace(/^"|"$/g, '') || undefined;
            }
        }
        if (raw && typeof raw === 'object') {
            const obj = raw as Record<string, any>;
            return obj.token ?? obj.accessToken ?? obj.access_token ?? obj.result?.token;
        }
        return undefined;
    }

    get<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
        return this.request<T>('GET', path, options);
    }

    post<T = any>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
        return this.request<T>('POST', path, { ...options, body });
    }

    put<T = any>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
        return this.request<T>('PUT', path, { ...options, body });
    }

    delete<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
        return this.request<T>('DELETE', path, options);
    }

    async request<T = any>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
        const retries = options.retries ?? 2;
        for (let attempt = 0; ; attempt += 1) {
            try {
                return await this.once<T>(method, path, options);
            } catch (err) {
                const status = err instanceof ApiError ? err.status : 0;
                const transient = status === 0 || status === 429 || status >= 500;
                if (!transient || attempt >= retries) throw err;
                await sleep(400 * 2 ** attempt + Math.random() * 250);
            }
        }
    }

    private async once<T>(method: string, path: string, options: RequestOptions): Promise<T> {
        const url = `${SisClient.apiBase(this.session.apiUrl)}/${path.replace(/^\/+/, '')}`;
        const headers: Record<string, string> = { Accept: 'application/json, text/plain, */*' };
        if (this.session.token) {
            headers.token = this.session.token;
            headers.ChartsApp = this.session.token;
        }
        let body: string | undefined;
        if (options.body !== undefined) {
            headers['Content-Type'] = options.contentType ?? 'application/json';
            body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
        }
        const started = Date.now();
        const log = (status: number | 'ERR', error?: string) => this.onLog({ time: new Date(started).toISOString(), method, path: path.split('?')[0], status, ms: Date.now() - started, error });
        let response: Response;
        try {
            response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(options.timeoutMs ?? 60_000) });
        } catch (err) {
            const message = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : (err as Error)?.cause ? String((err as any).cause?.code ?? (err as Error).message) : String(err);
            log('ERR', message);
            throw new ApiError(method, path, 0, message);
        }
        const text = await response.text();
        if (!response.ok) {
            const error = new ApiError(method, path, response.status, text);
            log(response.status, error.message);
            throw error;
        }
        log(response.status);
        if (!text) return undefined as T;
        try {
            return JSON.parse(text) as T;
        } catch {
            return text as T;
        }
    }
}

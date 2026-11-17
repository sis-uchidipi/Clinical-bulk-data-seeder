import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { verifyEraSettings } from './flows/remittance.ts';

/**
 * `npm run setup`: writes the local, git-ignored `.env` from `.env.example`, asking for each value. Values already in
 * `.env` are kept when you just press Enter, and secrets are never echoed or printed. Then checks the ERA values by
 * asking Azure AD for the app token.
 */
const ROOT = join(import.meta.dirname, '..');
const ENV_FILE = join(ROOT, '.env');
const EXAMPLE_FILE = join(ROOT, '.env.example');
const PROMPTS: { key: string; label: string; secret?: boolean }[] = [
    { key: 'SIS_ERA_TENANT_ID', label: 'ERA app tenant id' },
    { key: 'SIS_ERA_CLIENT_ID', label: 'ERA app client id' },
    { key: 'SIS_ERA_CLIENT_SECRET', label: 'ERA app client secret', secret: true },
];

function readEnv(file: string): Map<string, string> {
    const values = new Map<string, string>();
    if (!existsSync(file)) return values;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = /^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(line);
        if (match) values.set(match[1], match[2].replace(/^(['"])(.*)\1$/, '$2'));
    }
    return values;
}

/**
 * One prompt session for all questions (separate readline interfaces would lose piped input). A secret is typed blind:
 * nothing but the question is echoed, so it never shows on screen or in a terminal recording.
 */
function prompter() {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    const lines: string[] = [];
    const waiting: ((line: string) => void)[] = [];
    let muted = '';
    (rl as any)._writeToOutput = (text: string) => {
        if (!muted || text.includes(muted)) process.stdout.write(text);
    };
    rl.on('line', (line) => (waiting.length ? waiting.shift()!(line) : lines.push(line)));
    rl.on('close', () => waiting.splice(0).forEach((resolve) => resolve('')));
    return {
        ask(question: string, secret = false): Promise<string> {
            muted = secret ? question : '';
            process.stdout.write(question);
            const next = lines.length ? Promise.resolve(lines.shift()!) : new Promise<string>((resolve) => waiting.push(resolve));
            return next.then((answer) => {
                if (secret) process.stdout.write('\n');
                muted = '';
                return answer.trim();
            });
        },
        close: () => rl.close(),
    };
}

/** The example file with the values filled in, so comments and order stay; keys not in the example go at the end. */
function render(values: Map<string, string>): string {
    const template = existsSync(EXAMPLE_FILE) ? readFileSync(EXAMPLE_FILE, 'utf8') : PROMPTS.map((p) => `${p.key}=`).join('\n');
    const written = new Set<string>();
    const lines = template.split(/\r?\n/).map((line) => {
        const key = /^\s*([A-Za-z_]\w*)\s*=/.exec(line)?.[1];
        if (!key || !values.get(key)) return line;
        written.add(key);
        return `${key}=${values.get(key)}`;
    });
    for (const [key, value] of values) if (!written.has(key) && value) lines.push(`${key}=${value}`);
    return lines.join('\n').replace(/\n*$/, '\n');
}

async function main(): Promise<void> {
    const values = readEnv(ENV_FILE);
    console.log(`Clinical Seeder local settings → ${ENV_FILE}`);
    console.log('Only Remittance Posting needs these. Ask your team lead for the values. Press Enter to keep a value already set.\n');
    const input = prompter();
    for (const prompt of PROMPTS) {
        const current = values.get(prompt.key);
        const hint = current ? (prompt.secret ? ' [set, Enter keeps it]' : ` [${current}]`) : '';
        const answer = await input.ask(`${prompt.label}${hint}: `, prompt.secret);
        if (answer) values.set(prompt.key, answer);
    }
    input.close();
    writeFileSync(ENV_FILE, render(values));
    console.log('\nSaved .env (git-ignored, never commit it).');

    for (const prompt of PROMPTS) process.env[prompt.key] = values.get(prompt.key) ?? '';
    const missing = PROMPTS.filter((p) => !values.get(p.key)).map((p) => p.key);
    if (missing.length) {
        console.log(`Still missing: ${missing.join(', ')}. Remittance Posting stays off until they are set.`);
        return;
    }
    try {
        await verifyEraSettings();
        console.log('ERA settings work: Azure AD issued the app token. Restart the seeder (npm start) to use them.');
    } catch (err) {
        console.log(`ERA settings were saved but Azure AD refused them: ${(err as Error).message}`);
        process.exitCode = 1;
    }
}

await main();

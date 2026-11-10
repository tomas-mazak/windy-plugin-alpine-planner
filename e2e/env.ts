// The end-to-end tests' environment: the Windy client to test and the test accounts. Values come from the process
// environment, or from .env (git-ignored; see .env.example) through Node's built-in loader. Credential values are only
// ever passed to the login form: never printed, logged or put into a test title, error message or attachment.

import { fileURLToPath } from 'node:url';

try {
    process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {
    // no .env: the process environment only
}

export type Account = 'free' | 'premium';

// The Windy client under test, without a trailing slash. Tiles always come from ims.windy.com (the plugin's URLs).
export const WINDY_URL = (process.env.WINDY_URL || 'https://www.windy.com').replace(/\/+$/, '');

// The plugin as developer mode loads it; the tests route this URL to the built bundle (e2e/fixtures.ts).
export const PLUGIN_URL = 'https://localhost:9999/plugin.js';
export const PLUGIN_NAME = 'windy-plugin-alpine-planner';

// Saved login state per account (git-ignored).
export const authFile = (account: Account): string => fileURLToPath(new URL(`./.auth/${account}.json`, import.meta.url));

const VARIABLES: Record<Account, { user: string; password: string }> = {
    free: { user: 'WINDY_FREE_USER', password: 'WINDY_FREE_PASSWORD' },
    premium: { user: 'WINDY_PREMIUM_USER', password: 'WINDY_PREMIUM_PASSWORD' },
};

export const missingCredentialVariables = (): string[] =>
    Object.values(VARIABLES).flatMap(names => Object.values(names)).filter(name => !process.env[name]);

export function credentials(account: Account): { user: string; password: string } | null {
    const names = VARIABLES[account];
    const user = process.env[names.user];
    const password = process.env[names.password];
    return user && password ? { user, password } : null;
}

// Names the variables, never their values.
export const missingCredentials = (account: Account): string =>
    `${VARIABLES[account].user} / ${VARIABLES[account].password} not set: the ${account} account's tests are skipped`;

// Replaces the credential values (and anything that looks like a token) in text that goes into a report.
export function redact(text: string): string {
    const secrets = (['free', 'premium'] as const)
        .flatMap(account => Object.values(credentials(account) ?? {}))
        .filter(value => value.length >= 3);
    let out = text.replace(/(token|auth|session|key)=[^&\s"']+/gi, '$1=…').replace(/Bearer\s+[\w.~+/-]+=*/gi, 'Bearer …');
    for (const secret of secrets) {
        out = out.split(secret).join('…');
    }
    return out;
}

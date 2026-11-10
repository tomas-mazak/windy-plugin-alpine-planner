// End-to-end tests against a real Windy client (README, "End-to-end tests"). npm run test:e2e builds the plugin first;
// the tests serve dist/plugin.min.js at developer mode's URL (e2e/fixtures.ts).

import { defineConfig, devices } from '@playwright/test';

import { WINDY_URL } from './e2e/env';
import type { Options } from './e2e/fixtures';

// No page snapshot in a failed test's error-context.md (test-results/ and the report): it's an aria snapshot of the
// whole page, with the values of its text fields (the login form's) and Windy's header (the account). Set before the
// workers start, which inherit it.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

const DESKTOP = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } };
// Windy picks its mobile layout by user agent at startup: the phone profile's.
const PHONE = devices['Pixel 7'];

// The login projects: no trace, video or screenshot, ever (README, "Credentials and artifacts").
const LOGIN_ARTIFACTS = { trace: 'off', video: 'off', screenshot: 'off' } as const;

export default defineConfig<Options>({
    testDir: 'e2e',
    testMatch: '**/*.spec.ts', // *.test.ts are Node unit tests, not browser tests; login projects override this
    timeout: 120_000, // software WebGL is slow
    expect: { timeout: 60_000 }, // expect.poll on the test API: loading live tiles
    workers: 1, // the accounts share Windy-side state
    fullyParallel: false,
    retries: 0,
    forbidOnly: true,
    reporter: [['list'], ['html', { open: 'never' }]],
    use: {
        baseURL: WINDY_URL,
        // Session tokens live in cookies and localStorage, which a trace records: no traces. On failure the fixture
        // attaches screenshots of the plugin box and Windy's picker only (e2e/fixtures.ts).
        trace: 'off',
        video: 'off',
        screenshot: 'off',
        // page.route doesn't see requests a service worker handles
        serviceWorkers: 'block',
        actionTimeout: 30_000,
    },
    projects: [
        { name: 'setup-premium', testMatch: /auth\.setup\.ts/, use: { ...DESKTOP, ...LOGIN_ARTIFACTS, account: 'premium' } },
        { name: 'setup-free', testMatch: /auth\.setup\.ts/, use: { ...DESKTOP, ...LOGIN_ARTIFACTS, account: 'free' } },
        {
            name: 'desktop-premium',
            dependencies: ['setup-premium'],
            testIgnore: /mobile\.spec\.ts/,
            grepInvert: /@free|@noauth/,
            use: { ...DESKTOP, account: 'premium' },
        },
        {
            name: 'desktop-free',
            dependencies: ['setup-free'],
            testIgnore: /mobile\.spec\.ts/,
            grepInvert: /@premium|@noauth/,
            use: { ...DESKTOP, account: 'free' },
        },
        {
            name: 'mobile-free',
            dependencies: ['setup-free'],
            testMatch: /mobile\.spec\.ts/,
            grepInvert: /@premium|@noauth/,
            use: { ...PHONE, account: 'free' },
        },
        // No account: checks that the route serves the built plugin (runs without credentials)
        { name: 'noauth', grep: /@noauth/, use: DESKTOP },
    ],
});

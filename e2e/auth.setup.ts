// Logs a test account in through Windy's own login form and saves the session to e2e/.auth/<account>.json
// (git-ignored), for the account's projects. A saved login younger than REUSE_MS that still works is reused, so
// repeated runs don't log in every time. Its project records no trace, video or screenshot (playwright.config.ts).
//
// The credentials are typed with the Chrome DevTools Protocol (Input.insertText: real input events, which Windy's form
// needs; a synthetic input event leaves its fields empty), not with locator.fill or keyboard.*: Playwright puts their
// text into the report's step titles, while a CDP command's title is only "Send CDP command". They never appear in a
// title, message or attachment.

import { existsSync, statSync } from 'node:fs';

import { test as base, expect } from '@playwright/test';

import { authFile, credentials, missingCredentials, redact, type Account } from './env';
import { isLoggedIn, openDeveloperMode, openWindy } from './fixtures';

const REUSE_MS = 12 * 3600 * 1000;

const setup = base.extend<{ account: Account }>({
    account: ['free', { option: true }],
    storageState: async ({ account }, use) => {
        const file = authFile(account);
        const recent = existsSync(file) && Date.now() - statSync(file).mtimeMs < REUSE_MS;
        await use(recent ? file : undefined);
    },
});

setup('log in', async ({ page, account }) => {
    const login = credentials(account);
    setup.skip(!login, missingCredentials(account));

    await openWindy(page);

    if (!(await isLoggedIn(page))) {
        await page.evaluate(() => window.W.broadcast.emit('rqstOpen', 'login'));
        const form = page.locator('#plugin-login form');
        await expect(form.locator('#email'), "Windy's login form").toBeVisible();
        const cdp = await page.context().newCDPSession(page);
        for (const [id, text] of [['email', login!.user], ['password', login!.password]]) {
            await form.locator(`#${id}`).click();
            await cdp.send('Input.insertText', { text });
        }
        await cdp.detach();
        await form.locator('#submitLogin').click();

        const error = page.locator('#plugin-login .bg-error');
        await expect
            .poll(async () => ((await isLoggedIn(page)) ? 'logged in' : (await error.isVisible()) ? 'error' : 'waiting'), {
                message: `log in the ${account} account (no answer: bot protection? try npm run test:e2e:headed)`,
                timeout: 90_000, // headed: time to solve a challenge by hand
            })
            .not.toBe('waiting');
        if (!(await isLoggedIn(page))) {
            throw new Error(`Windy refused the ${account} account's login: ${redact((await error.textContent())?.trim() ?? '')}`);
        }
    }

    // Developer mode's one-time consent, for this account (openDeveloperMode accepts it when shown)
    await openDeveloperMode(page);

    await page.context().storageState({ path: authFile(account), indexedDB: true });
});

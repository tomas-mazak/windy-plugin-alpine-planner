// Without an account (project noauth): Windy loads, and the route serves the built plugin at developer mode's URL,
// both to fetch() and to the cross-origin import() developer mode uses.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { test, expect } from '@playwright/test';

import { PLUGIN_NAME, PLUGIN_URL, WINDY_URL } from './env';
import { routePlugin } from './fixtures';

const BUNDLE = fileURLToPath(new URL('../dist/plugin.min.js', import.meta.url));

test('the route serves the built plugin to Windy\'s page @noauth', async ({ context, page }) => {
    await routePlugin(context);
    let routed = 0;
    page.on('request', request => {
        if (request.url() === PLUGIN_URL) {
            routed++;
        }
    });

    await page.goto(`${WINDY_URL}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.W?.store, null, { timeout: 60_000 });

    const fetched = await page.evaluate(async url => {
        const response = await fetch(url);
        return { status: response.status, type: response.headers.get('content-type'), length: (await response.text()).length };
    }, PLUGIN_URL);
    expect(fetched).toEqual({ status: 200, type: 'text/javascript', length: new TextDecoder().decode(readFileSync(BUNDLE)).length });

    // As installExternalPlugin does: import(url), then the module's __pluginConfig
    const config = await page.evaluate(async url => {
        const module = (await import(url)) as { __pluginConfig?: { name: string; version: string } };
        return { name: module.__pluginConfig?.name, version: module.__pluginConfig?.version };
    }, PLUGIN_URL);
    const { version } = JSON.parse(new TextDecoder().decode(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)))));
    expect(config).toEqual({ name: PLUGIN_NAME, version });
    expect(routed, 'both requests went through the route').toBe(2);
});

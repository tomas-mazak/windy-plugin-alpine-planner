// The test fixture: every test gets a fresh browser context logged in with its project's account, Windy at a fixed
// starting view, and the plugin installed and opened through developer mode, as a user would. It fails the test on
// console errors from our code. Specs import { test, expect } from here.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { test as base, expect, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test';

import { PLUGIN_NAME, PLUGIN_URL, WINDY_URL, authFile, credentials, missingCredentials, redact, type Account } from './env';

export { expect };

const BUNDLE = fileURLToPath(new URL('../dist/plugin.min.js', import.meta.url));
const PACKAGE = fileURLToPath(new URL('../package.json', import.meta.url));
export const TEST_KEY = 'windy-plugin-alpine-planner:test';
export const STATE_KEY = 'windy-plugin-alpine-planner:state';

// The fixed starting view: the Valais Alps, temperature at the surface, ECMWF.
export const START = { lat: 46.0, lon: 7.7, zoom: 8 };
const HOUR = 3600 * 1000;

// The next 06:00 UTC: within the free forecast horizon.
export function nextMorning(now = Date.now()): number {
    const t = new Date(now);
    t.setUTCHours(6, 0, 0, 0);
    return t.getTime() > now ? t.getTime() : t.getTime() + 24 * HOUR;
}

// --- Serving the plugin ---

// Developer mode import()s https://localhost:9999/plugin.js; this answers it with the built bundle, no dev server.
export async function routePlugin(context: BrowserContext): Promise<void> {
    if (!existsSync(BUNDLE)) {
        throw new Error('dist/plugin.min.js is missing: run `npm run build` (npm run test:e2e does it first)');
    }
    const body = readFileSync(BUNDLE);
    await context.route(PLUGIN_URL, route =>
        route.fulfill({
            status: 200,
            contentType: 'text/javascript',
            headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }, // a cross-origin module import
            body,
        }),
    );
}

// --- Windy ---

export async function openWindy(page: Page): Promise<void> {
    await page.goto(`${WINDY_URL}/`, { waitUntil: 'domcontentloaded' });
    await waitForWindy(page);
}

// Windy is ready: its modules are on the page (W), and its consent popup is out of the way.
export async function waitForWindy(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            const W = window.W;
            return !!(W?.store && W.map?.map && W.broadcast && W.user && W.renderers?.tileLayer && W.overlays?.temp);
        },
        null,
        { timeout: 60_000 },
    );
    await dismissConsent(page);
}

// Windy's analytics consent popup, when it shows (it covers the map): Reject, or whatever its next screen offers.
export async function dismissConsent(page: Page): Promise<void> {
    const popup = page.locator('#plugin-consent');
    const choices = [
        popup.getByTestId('consent-reject-button'),
        popup.getByTestId('consent-accept-analytics'), // the next screen for logged-out users: log in, or allow
        popup.locator('.button').first(), // "Ok"
    ];
    for (let i = 0; i < 3 && (await popup.isVisible()); i++) {
        for (const choice of choices) {
            if (await choice.isVisible()) {
                await choice.click();
                break;
            }
        }
        await expect.poll(() => popup.isVisible(), { timeout: 5_000 }).toBe(false).catch(() => {});
    }
}

// Windy's isLoggedInPromise waits for its auth request, which a logged-out page never sends: then it never resolves.
// So: its answer, or after 10 s whether the user store is set.
export const isLoggedIn = (page: Page): Promise<boolean> =>
    page.evaluate(() =>
        Promise.race([
            window.W.user.isLoggedInPromise(),
            new Promise<boolean>(resolve => setTimeout(() => resolve(!!window.W.store.get('user')), 10_000)),
        ]),
    );

// Developer mode, opened as from Windy's menu. Its one-time consent is accepted if shown (the login setup does it).
export async function openDeveloperMode(page: Page): Promise<Locator> {
    await page.evaluate(() => window.W.broadcast.emit('rqstOpen', 'developer-mode'));
    const pane = page.locator('#plugin-developer-mode');
    const accept = pane.locator('.button', { hasText: /^\s*Accept\s*$/ });
    const input = pane.locator('input[type="text"]');
    await expect(input.or(accept), 'developer mode shows neither its URL field nor its consent: logged out?').toBeVisible();
    if (await accept.isVisible()) {
        await accept.click();
        await expect(input).toBeVisible();
    }
    return pane;
}

async function checkWebGL2(page: Page): Promise<void> {
    const version = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        return gl ? String(gl.getParameter(gl.VERSION)) : null;
    });
    expect(version, 'WebGL2 is not available in this browser: the plugin and Windy need it').not.toBeNull();
}

// The starting view, through Windy's own store and map.
export async function setStartView(page: Page, timestamp = nextMorning()): Promise<void> {
    await page.evaluate(
        ({ lat, lon, zoom, ts }) => {
            const { store, map } = window.W;
            store.set('mapLibrary', 'leafletGl');
            store.set('overlay', 'temp');
            store.set('product', 'ecmwf');
            store.set('level', 'surface');
            store.set('timestamp', ts);
            map.map.setView([lat, lon], zoom);
        },
        { ...START, ts: timestamp },
    );
    await expect
        .poll(() => page.evaluate(() => ['overlay', 'level', 'product'].map(key => window.W.store.get(key))))
        .toEqual(['temp', 'surface', 'ecmwf']);
}

// Windy's own interpolator, picker formatter and user control before the plugin touches them.
async function saveWindyOriginals(page: Page): Promise<void> {
    await page.evaluate(() => {
        const { renderers, overlays } = window.W;
        window.__e2eWindy = {
            interpolator: renderers.tileLayer.interpolator,
            createPickerHTML: overlays.temp.createPickerHTML,
            userControl: String(renderers.tileLayer.userControl),
        };
    });
}

// Developer mode's "Install & open plugin" with the local URL; then its pane is closed again.
export async function installAndOpenPlugin(page: Page): Promise<void> {
    const pane = await openDeveloperMode(page);
    const input = pane.locator('input[type="text"]');
    await input.fill(PLUGIN_URL);
    await input.dispatchEvent('change'); // developer mode saves the URL on change
    await pane.getByText('Install & open plugin', { exact: true }).click();
    await expect
        .poll(
            () =>
                page.evaluate(() =>
                    window.__alpinePlanner
                        ? 'open'
                        : document.querySelector('#plugin-developer-mode .bg-error')?.textContent?.trim() || 'waiting',
                ),
            { message: 'the plugin opens with its test API' },
        )
        .toBe('open');
    await page.evaluate(() => window.W.broadcast.emit('rqstClose', 'developer-mode'));
}

// --- The plugin, for the specs ---

export class App {
    readonly panel: Locator;
    readonly box: Locator;
    readonly infoButton: Locator;

    constructor(
        readonly page: Page,
        readonly mobile: boolean,
    ) {
        this.panel = page.locator('.alpine-planner');
        this.box = page.locator(`#plugin-${PLUGIN_NAME}`);
        this.infoButton = this.panel.getByRole('button', { name: 'About Alpine planner' });
    }

    // --- The test API ---

    state = (): Promise<ReturnType<TestApi['state']>> => this.page.evaluate(() => window.__alpinePlanner!.state());
    status = (): Promise<ReturnType<TestApi['status']>> => this.page.evaluate(() => window.__alpinePlanner!.status());
    hooks = (): Promise<ReturnType<TestApi['hooks']>> => this.page.evaluate(() => window.__alpinePlanner!.hooks());
    boxSize = (): Promise<{ width: number; height: number }> => this.page.evaluate(() => window.__alpinePlanner!.boxSize());

    // Until the tool's layer has loaded everything in view and shows a status line.
    async waitLoaded(tool: 'temp' | 'mask'): Promise<void> {
        await expect
            .poll(async () => {
                const s = await this.status();
                return s.loading[tool] ? 'loading' : s[tool].length ? 'loaded' : 'no status';
            }, { message: `${tool}: loading ends` })
            .toBe('loaded');
    }

    // Desktop: Windy's box is 320 × 200 px in every state.
    async expectDesktopBox(): Promise<void> {
        if (this.mobile) {
            return;
        }
        const { width, height } = await this.boxSize();
        expect({ width: Math.round(width), height: Math.round(height) }, 'the plugin box').toEqual({ width: 320, height: 200 });
    }

    // --- Controls ---

    tab(tool: 'TEMP' | 'MASK'): Locator {
        return this.panel.getByRole('tab').filter({ hasText: tool });
    }

    // A pill of one of the switches: 'Temperature mode', 'Mask mode', 'Isotherm mode'.
    pill(group: 'Temperature mode' | 'Mask mode' | 'Isotherm mode', label: string): Locator {
        return this.panel.getByRole('navigation', { name: group }).getByRole('button', { name: label, exact: true });
    }

    // The visible tool's lapse rate correction toggle.
    correction(): Locator {
        return this.panel.getByRole('switch', { name: /Lapse rate corr/ });
    }

    async selectTool(tool: 'TEMP' | 'MASK'): Promise<void> {
        await this.tab(tool).click();
        await expect(this.tab(tool)).toHaveAttribute('aria-selected', 'true');
    }

    // Types into a number field and commits with Enter, as a user would.
    async typeNumber(label: string, text: string): Promise<void> {
        const field = this.panel.getByRole('textbox', { name: label, exact: true });
        await field.click();
        await field.fill(text);
        await field.press('Enter');
    }

    // Drags a slider's handle by `steps` steps with the mouse (clamped to its ends). Not with the arrow keys: Windy's
    // keyboard handler takes them first and moves its timeline instead (found by these tests; docs/windy-integration.md, "Keyboard").
    async dragSlider(name: string, steps: number): Promise<void> {
        const slider = this.panel.getByRole('slider', { name, exact: true });
        const { min, max, value } = await slider.evaluate(element => {
            const input = element as HTMLInputElement;
            return { min: Number(input.min), max: Number(input.max), value: Number(input.value) };
        });
        const box = (await slider.boundingBox())!;
        const thumb = box.height; // the input is as tall as its thumb (slider.less)
        const x = (v: number): number => box.x + thumb / 2 + ((v - min) / (max - min || 1)) * (box.width - thumb);
        const y = box.y + box.height / 2;
        await this.page.mouse.move(x(value), y);
        await this.page.mouse.down();
        await this.page.mouse.move(x(Math.min(Math.max(value + steps, min), max)), y, { steps: 5 });
        await this.page.mouse.up();
    }

    // Windy's ×, as a user would close the plugin; the test API goes with it.
    async close(): Promise<void> {
        const x = this.box.locator(':scope > .closing-x');
        if (await x.isVisible()) {
            await x.click();
        } else {
            await this.page.evaluate(name => window.W.broadcast.emit('rqstClose', name), PLUGIN_NAME);
        }
        await expect.poll(() => this.page.evaluate(() => !!window.__alpinePlanner), { message: 'the plugin closes' }).toBe(false);
    }

    async reopen(): Promise<void> {
        await installAndOpenPlugin(this.page);
    }

    // A browser reload, then the starting view and the plugin again (the remembered state is kept: see the fixture).
    async reload(): Promise<void> {
        await this.page.reload({ waitUntil: 'domcontentloaded' });
        await waitForWindy(this.page);
        await setStartView(this.page);
        await installAndOpenPlugin(this.page);
    }

    // The map point's position on the page.
    async mapPoint(lat: number, lon: number): Promise<{ x: number; y: number }> {
        return this.page.evaluate(([la, lo]) => window.W.map.map.latLngToContainerPoint([la, lo]), [lat, lon] as const);
    }

    // Sets a Windy store value, as Windy's own controls do.
    async setStore(key: string, value: unknown): Promise<void> {
        await this.page.evaluate(([k, v]) => window.W.store.set(k as string, v), [key, value] as const);
    }

    // The current model's calendar.
    calendar(): Promise<Calendar> {
        return this.page.evaluate(async () => {
            const { timestamps, premiumStart, start, end } = await window.W.products[window.W.store.get('product')]!.getCalendar();
            return { timestamps, premiumStart, start, end };
        });
    }

    // Everything of Windy's is back: its interpolator and picker formatter, its user control, its layer shown.
    async expectWindyRestored(): Promise<void> {
        await expect
            .poll(
                () =>
                    this.page.evaluate(() => {
                        const { renderers, overlays, map } = window.W;
                        const original = window.__e2eWindy!;
                        const ml = map.map.maplibreMap;
                        const ids = ['tileLayer', 'noUserControl', 'daySwitcher', 'accumulations', 'levelsRange', 'fireDanger'];
                        return {
                            interpolator: renderers.tileLayer.interpolator === original.interpolator,
                            picker: overlays.temp.createPickerHTML === original.createPickerHTML,
                            userControl: String(renderers.tileLayer.userControl) === original.userControl,
                            windyLayerHidden: ids.some(id => ml.getLayer(id) && ml.getLayoutProperty(id, 'visibility') === 'none'),
                        };
                    }),
                { message: "Windy's originals are back" },
            )
            .toEqual({ interpolator: true, picker: true, userControl: true, windyLayerHidden: false });
        const timeline = this.page.locator(this.mobile ? '#plugin-mobile-calendar' : '#plugin-progress-bar');
        await expect(timeline, "Windy's native timeline").toBeVisible();
        await expect(this.page.locator('#plugin-accumulations')).toBeHidden();
    }
}

// --- The fixture ---

export type Options = {
    account: Account;
    clearState: boolean; // clear our remembered state before the test's first page load (not on reloads)
};

async function attachFailureScreenshots(page: Page, testInfo: TestInfo): Promise<void> {
    // Only the plugin box and Windy's picker: never the whole page (Windy's header shows the account).
    for (const [name, selector] of [
        ['plugin-box', `#plugin-${PLUGIN_NAME}`],
        ['picker', '.picker'],
    ]) {
        const element = page.locator(selector).first();
        if (await element.isVisible().catch(() => false)) {
            await testInfo.attach(name, { body: await element.screenshot(), contentType: 'image/png' });
        }
    }
}

export const test = base.extend<Options & { app: App }>({
    account: ['free', { option: true }],
    clearState: [true, { option: true }],

    // The account's saved login (e2e/auth.setup.ts); no credentials: the test is skipped.
    storageState: async ({ account }, use, testInfo) => {
        if (!credentials(account)) {
            testInfo.skip(true, missingCredentials(account));
        }
        const file = authFile(account);
        if (!existsSync(file)) {
            throw new Error(`No saved login for the ${account} account: its setup project (setup-${account}) didn't run or failed`);
        }
        await use(file);
    },

    context: async ({ context }, use) => {
        await routePlugin(context);
        await use(context);
    },

    app: async ({ page, account, clearState, isMobile }, use, testInfo) => {
        // Console errors: ours fail the test, Windy's are only attached to the report.
        const ours: string[] = [];
        const windys: string[] = [];
        page.on('console', message => {
            if (message.type() === 'error') {
                const text = message.text();
                const fromUs = text.includes('[alpine-planner]') || message.location().url.startsWith(PLUGIN_URL);
                (fromUs ? ours : windys).push(text);
            }
        });
        page.on('pageerror', error => {
            const text = error.stack ?? error.message;
            (text.includes(PLUGIN_URL) || text.includes('[alpine-planner]') ? ours : windys).push(text);
        });

        // Before Windy's scripts: the test API on; our state cleared on the test's first load only, so reloads keep it.
        await page.addInitScript(
            ({ testKey, stateKey, clear }) => {
                if (window !== window.top) {
                    return;
                }
                localStorage.setItem(testKey, '1');
                if (clear && !sessionStorage.getItem('e2e:loaded')) {
                    localStorage.removeItem(stateKey);
                }
                sessionStorage.setItem('e2e:loaded', '1');
            },
            { testKey: TEST_KEY, stateKey: STATE_KEY, clear: clearState },
        );

        await openWindy(page);
        expect(await isLoggedIn(page), `not logged in with the saved ${account} login: delete e2e/.auth/${account}.json and rerun`).toBe(true);
        await expect
            .poll(() => page.evaluate(() => window.W.subscription.hasAny()), { message: `the ${account} account's subscription`, timeout: 15_000 })
            .toBe(account === 'premium');
        await checkWebGL2(page);
        await setStartView(page);
        await saveWindyOriginals(page);
        await installAndOpenPlugin(page);

        const version = (JSON.parse(new TextDecoder().decode(readFileSync(PACKAGE))) as { version: string }).version;
        expect(await page.evaluate(() => window.__alpinePlanner!.version), 'the built plugin is this version').toBe(version);

        await use(new App(page, isMobile));

        if (testInfo.status !== testInfo.expectedStatus) {
            await attachFailureScreenshots(page, testInfo);
        }
        if (windys.length) {
            await testInfo.attach('windy-console-errors', { body: redact(windys.join('\n\n')), contentType: 'text/plain' });
        }
        if (ours.length) {
            await testInfo.attach('plugin-console-errors', { body: redact(ours.join('\n\n')), contentType: 'text/plain' });
        }
        expect(ours.map(redact), 'console errors from the plugin').toEqual([]);
    },
});

// The mask (MASK): typed elevations, the isotherm following the timeline, and its own time window.

import { test, expect, type App } from './fixtures';

async function isotherm(app: App, isoMode?: 'Min' | 'Max' | 'Both'): Promise<void> {
    await app.selectTool('MASK');
    await app.pill('Mask mode', 'Isotherm').click();
    if (isoMode) {
        await app.pill('Isotherm mode', isoMode).click();
        await expect(app.panel.getByRole('slider', { name: 'Window start' }), 'the window slider').toBeVisible();
    }
    await app.waitLoaded('mask');
}

test('Elevation: typed numbers with separators commit', async ({ app }) => {
    await app.selectTool('MASK');
    await app.pill('Mask mode', 'Elevation').click();
    await app.typeNumber('Lowest elevation', '1,800');
    await expect.poll(async () => (await app.state()).values.from).toBe(1800);
    await app.typeNumber('Highest elevation', '2 800');
    await expect.poll(async () => (await app.state()).values.to).toBe(2800);
    await expect(app.tab('MASK').locator('.alpine-planner__summary')).toHaveText('1,800–2,800');
    await app.expectDesktopBox();
});

test('Isotherm Instant follows the timeline', async ({ app }) => {
    await isotherm(app);
    expect((await app.status()).mask[0]).toMatch(/^Follows timeline · /);
    await app.expectDesktopBox();
});

test('Isotherm Min / Max / Both: a fixed window, switching without new requests', async ({ app, page }) => {
    const deg0Requests: string[] = [];
    page.on('request', request => {
        if (request.url().includes('deg0-surface')) {
            deg0Requests.push(request.url());
        }
    });

    await isotherm(app, 'Both');
    let status = await app.status();
    expect(status.mask[0]).toMatch(/^Fixed window · \d+ steps?/);
    expect(status.failed.mask).toBe(0);
    await app.expectDesktopBox();
    const loaded = deg0Requests.length;
    expect(loaded, 'the window loaded deg0 tiles').toBeGreaterThan(0);

    for (const [label, isoMode] of [['Min', 'min'], ['Max', 'max'], ['Both', 'both']] as const) {
        await app.pill('Isotherm mode', label).click();
        await expect.poll(async () => (await app.state()).mask.isoMode).toBe(isoMode);
        await app.waitLoaded('mask');
        status = await app.status();
        expect(status.mask[0]).toMatch(/^Fixed window · /);
        expect(status.failed.mask).toBe(0);
        expect(deg0Requests.length, `${label}: the same steps, no new deg0 requests`).toBe(loaded);
        await app.expectDesktopBox();
    }
});

test("Scrubbing Windy's timeline doesn't move the window", async ({ app }) => {
    await isotherm(app, 'Both');
    const isoWindow = (await app.state()).mask.window;
    expect(isoWindow).not.toBeNull();

    // A model step inside the window: the timeline tick on the window slider moves there
    const { timestamps } = await app.calendar();
    const inside = timestamps.find(ts => ts > isoWindow!.start && ts < isoWindow!.end);
    expect(inside, 'a step inside the window').toBeDefined();
    const tick = app.panel.locator('.tick');
    const before = await tick.getAttribute('style');
    await app.setStore('timestamp', inside);
    await expect(tick, 'the timeline tick moves').not.toHaveAttribute('style', before ?? '');

    expect((await app.state()).mask.window).toEqual(isoWindow);
    expect((await app.status()).mask[0]).toMatch(/^Fixed window · /);
});

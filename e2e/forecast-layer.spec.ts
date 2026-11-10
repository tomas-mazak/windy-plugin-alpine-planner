// The forecast layer (TEMP): Instant leaves Windy alone; Max patches Windy (range selector, hidden layer, picker); every
// way out restores Windy completely.

import { test, expect, dismissConsent, START, type App } from './fixtures';

// A map point near the start view's centre, away from the map labels' usual places.
const POINT = { lat: START.lat + 0.12, lon: START.lon - 0.18 };

const NOTHING_PATCHED = {
    interpolator: false,
    picker: false,
    rangeControl: false,
    windyLayerHidden: false,
    interpolatorIsWindys: true,
    userControl: 'progress-bar',
};

async function startMax(app: App): Promise<void> {
    await app.pill('Temperature mode', 'Max').click();
    await expect
        .poll(() => app.hooks(), { message: 'Max patches Windy' })
        .toMatchObject({ interpolator: true, picker: true, rangeControl: true, windyLayerHidden: true, userControl: 'accumulations' });
    await expect(app.page.locator('#plugin-accumulations'), "Windy's range selector").toBeVisible();
    await expect(app.page.locator('#plugin-progress-bar'), "Windy's timeline").toBeHidden();
}

// Clicks the map point and waits for Windy's picker. If the click lands on a map label (Windy opens the point forecast
// instead), the picker is opened the way Windy's own click handler does.
async function pickAt(app: App, { lat, lon } = POINT): Promise<void> {
    const { page } = app;
    await dismissConsent(page);
    const { x, y } = await app.mapPoint(lat, lon);
    await page.mouse.click(x, y);
    const picker = page.locator('.picker');
    const opened = await picker.waitFor({ state: 'visible', timeout: 5_000 }).then(
        () => true,
        () => false,
    );
    if (!opened) {
        test.info().annotations.push({ type: 'note', description: 'the map click hit a label: picker opened via rqstOpen' });
        await page.evaluate(([la, lo]) => {
            window.W.broadcast.emit('rqstClose', 'detail');
            window.W.broadcast.emit('rqstOpen', 'picker', { lat: la, lon: lo });
        }, [lat, lon] as const);
    }
    await expect(picker).toBeVisible();
}

test('Instant patches nothing: Windy keeps its interpolator and timeline', async ({ app, page }) => {
    await expect.poll(() => app.hooks()).toMatchObject(NOTHING_PATCHED);
    await expect(page.locator('#plugin-progress-bar')).toBeVisible();
    expect((await app.status()).temp).toEqual([]);
});

test('Max: the range selector, our layer, loading ends with no failures', async ({ app }) => {
    await startMax(app);
    await app.waitLoaded('temp');
    const status = await app.status();
    expect(status.temp[0]).toMatch(/^Timeline window · \d+ steps, [\d.–]+-hourly$/);
    expect(status.failed.temp).toBe(0);
    await app.expectDesktopBox();
});

test("Max: Windy's picker shows Max and the extreme's time", async ({ app, page }) => {
    await startMax(app);
    await pickAt(app);
    const content = page.locator('.picker .picker__content');
    await expect(content.locator('span.picker-subtext')).toHaveText('Max');
    await expect(content.locator('div.picker-subtext')).toHaveText(/\d{1,2}:\d{2}/);
});

test("Max + correction: loading ends, the picker's second line shows the height", async ({ app, page }) => {
    await startMax(app);
    await app.correction().click();
    await expect(app.correction()).toHaveAttribute('aria-checked', 'true');
    expect((await app.state()).temp).toEqual({ mode: 'max', correction: true });
    await pickAt(app);
    // "Wed 14:00 · 1,840 m": only the corrected source knows the height
    await expect(page.locator('.picker .picker__content div.picker-subtext')).toHaveText(/\d{1,2}:\d{2}.* · [\d,.\s]+ ?(m|ft)$/);
    await app.waitLoaded('temp');
    expect((await app.status()).failed.temp).toBe(0);
    await app.expectDesktopBox();
});

test.describe('every way out of Max restores Windy', () => {
    test.beforeEach(async ({ app }) => {
        await startMax(app);
    });

    test('back to Instant', async ({ app }) => {
        await app.pill('Temperature mode', 'Instant').click();
        await expect.poll(() => app.hooks()).toMatchObject(NOTHING_PATCHED);
        await app.expectWindyRestored();
    });

    test('the overlay switched to Wind', async ({ app }) => {
        await app.setStore('overlay', 'wind');
        await expect(app.tab('TEMP').locator('.alpine-planner__summary')).toHaveText('paused');
        await expect.poll(() => app.hooks()).toMatchObject({ ...NOTHING_PATCHED, userControl: expect.any(String) });
        await app.expectWindyRestored();
        await app.expectDesktopBox();
    });

    test('the 3D globe', async ({ app }) => {
        await app.setStore('mapLibrary', 'globe');
        await expect.poll(async () => (await app.status()).temp).toEqual(['Hidden in 3D globe view']);
        await expect.poll(() => app.hooks()).toMatchObject({ interpolator: false, picker: false, rangeControl: false, interpolatorIsWindys: true });
        await app.expectWindyRestored();
        await app.expectDesktopBox();
    });

    test('the plugin closed', async ({ app }) => {
        await app.close();
        await app.expectWindyRestored();
    });
});

// The remembered state (src/lib/pluginState.ts): restored exactly after a reload within 60 minutes; after that only
// the values (range, offset) are kept. The fixture clears the state before each test's first page load, not on reloads.

import { test, expect, STATE_KEY, type App } from './fixtures';

// TEMP Max + correction; MASK Isotherm Both with a moved window and +200 m; the MASK tab left selected.
async function setEverything(app: App): Promise<void> {
    await app.pill('Temperature mode', 'Max').click();
    await app.correction().click();
    await expect(app.correction()).toHaveAttribute('aria-checked', 'true');

    await app.selectTool('MASK');
    await app.pill('Mask mode', 'Elevation').click();
    await app.typeNumber('Lowest elevation', '1800');
    await app.typeNumber('Highest elevation', '2800');
    await app.pill('Mask mode', 'Isotherm').click();
    await app.pill('Isotherm mode', 'Both').click();
    const start = app.panel.getByRole('slider', { name: 'Window start' });
    await expect(start).toBeVisible();
    const initial = (await app.state()).mask.window;
    await app.dragSlider('Window start', 1); // one step later: a custom window
    await expect.poll(async () => (await app.state()).mask.window).not.toEqual(initial);
    await app.typeNumber('Offset', '+200');
    await expect.poll(async () => (await app.state()).values.offset).toBe(200);
}

// The stored state's fields equal what the test API reports (the debounced save has happened).
async function expectSaved(app: App): Promise<void> {
    const current = await app.state();
    await expect
        .poll(() =>
            app.page.evaluate(key => {
                const { values, activity } = JSON.parse(localStorage.getItem(key) ?? '{}');
                const { isoWindow, ...mask } = activity?.mask ?? {};
                return { tool: activity?.tool, temp: activity?.temp, mask: { ...mask, window: isoWindow }, values };
            }, STATE_KEY),
        )
        .toEqual(current);
}

test('a reload within the hour restores everything', async ({ app }) => {
    await setEverything(app);
    const before = await app.state();
    await expectSaved(app);

    await app.reload();
    expect(await app.state()).toEqual(before);
    await expect(app.tab('MASK')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => (await app.hooks()).rangeControl, { message: 'Max: the range selector again' }).toBe(true);
    await app.expectDesktopBox();
});

test('after 61 minutes only the range and the offset are kept', async ({ app, page }) => {
    await setEverything(app);
    // Closing saves; with the plugin closed, nothing refreshes savedAt on the reload
    await app.close();
    await page.evaluate(key => {
        const stored = JSON.parse(localStorage.getItem(key)!);
        stored.savedAt -= 61 * 60 * 1000;
        localStorage.setItem(key, JSON.stringify(stored));
    }, STATE_KEY);

    await app.reload();
    expect(await app.state()).toEqual({
        tool: 'temp',
        temp: { mode: 'instant', correction: false },
        mask: { mode: 'off', isoMode: 'instant', isoCorrection: false, window: null },
        values: { from: 1800, to: 2800, offset: 200 },
    });
});

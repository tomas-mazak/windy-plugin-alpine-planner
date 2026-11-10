// A free account at the free forecast horizon (premiumStart): the isotherm window and the forecast window stop there
// and say so; Instant exactly at premiumStart is still free (the premium boundary rule, src/lib/steps.ts).

import { test, expect, type App } from './fixtures';

const HOUR = 3600 * 1000;

// ECMWF's free forecast horizon, and its last step within it.
async function freeHorizon(app: App): Promise<{ premiumStart: number; lastFree: number; timestamps: number[] }> {
    const { premiumStart, timestamps } = await app.calendar();
    expect(premiumStart, 'ECMWF has a free forecast horizon').not.toBeNull();
    const lastFree = Math.max(...timestamps.filter(ts => ts <= premiumStart!));
    return { premiumStart: premiumStart!, lastFree, timestamps };
}

test.describe('free account @free', () => {
    test('the isotherm window stops at the free limit, with the free note', async ({ app }) => {
        const { premiumStart, lastFree } = await freeHorizon(app);
        // The timeline 6 h before the last free step: the initial window (timeline + 12 h) is cut by the horizon
        await app.setStore('timestamp', lastFree - 6 * HOUR);
        await app.selectTool('MASK');
        await app.pill('Mask mode', 'Isotherm').click();
        await app.pill('Isotherm mode', 'Both').click();
        await app.waitLoaded('mask');

        const status = await app.status();
        expect(status.mask).toContainEqual(expect.stringMatching(/^Free forecast ends /));
        const isoWindow = (await app.state()).mask.window;
        expect(isoWindow).toMatchObject({ end: lastFree, clipped: true });
        await app.expectDesktopBox();

        // The end handle can't go past the last free step: dragged to the slider's end, then beyond it
        await app.dragSlider('Window end', -2);
        await expect.poll(async () => (await app.state()).mask.window?.end, { message: 'the handle moved' }).toBeLessThan(lastFree);
        await app.dragSlider('Window end', 1000);
        await expect.poll(async () => (await app.state()).mask.window?.end).toBe(lastFree);
        expect(lastFree).toBeLessThanOrEqual(premiumStart);
    });

    test('a forecast Max window past the free limit drops the premium steps', async ({ app }) => {
        const { lastFree } = await freeHorizon(app);
        await app.pill('Temperature mode', 'Max').click();
        await expect.poll(async () => (await app.hooks()).rangeControl).toBe(true);
        // As dragging Windy's range selector: start a day before the limit, 72 h long
        await app.setStore('timestamp', lastFree - 24 * HOUR);
        await app.setStore('acRange', 72);
        await expect
            .poll(async () => (await app.status()).temp, { message: 'the free note in the status' })
            .toContainEqual(expect.stringMatching(/^Free forecast ends .+: \d+ dropped$/));
        await app.waitLoaded('temp');
        await app.expectDesktopBox();
    });

    test('Isotherm Instant exactly at premiumStart shows the mask', async ({ app }) => {
        const { premiumStart } = await freeHorizon(app);
        await app.setStore('timestamp', premiumStart);
        await app.selectTool('MASK');
        await app.pill('Mask mode', 'Isotherm').click();
        await app.waitLoaded('mask');
        const status = await app.status();
        expect(status.mask[0]).toMatch(/^Follows timeline · /);
        expect(status.mask.join(' ')).not.toContain('Premium time');
    });
});

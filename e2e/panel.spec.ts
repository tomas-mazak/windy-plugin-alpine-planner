// The panel: opening, the TEMP / MASK tabs and their summaries, the desktop box size, the help.

import { test, expect, type App } from './fixtures';

const summary = (app: App, tool: 'TEMP' | 'MASK') => app.tab(tool).locator('.alpine-planner__summary');

test('the plugin opens on the TEMP tab, in a 320 × 200 box', async ({ app }) => {
    await expect(app.panel).toBeVisible();
    await expect(app.tab('TEMP')).toHaveAttribute('aria-selected', 'true');
    expect((await app.state()).tool).toBe('temp');
    await expect(summary(app, 'TEMP')).toHaveText('Instant');
    await expect(summary(app, 'MASK')).toHaveText('Off');
    await app.expectDesktopBox();
});

test('the tabs switch, and their summaries follow the settings', async ({ app }) => {
    await app.selectTool('MASK');
    expect((await app.state()).tool).toBe('mask');
    await app.expectDesktopBox();

    await app.pill('Mask mode', 'Elevation').click();
    await expect(summary(app, 'MASK')).toHaveText('1,700–8,000+');
    await app.typeNumber('Lowest elevation', '1800');
    await expect(summary(app, 'MASK')).toHaveText('1,800–8,000+');
    await app.expectDesktopBox();

    await app.pill('Mask mode', 'Isotherm').click();
    await expect(summary(app, 'MASK')).toHaveText('0 °C · Instant');
    await app.waitLoaded('mask');
    await app.expectDesktopBox();

    await app.selectTool('TEMP');
    expect((await app.state()).tool).toBe('temp');
    await app.pill('Temperature mode', 'Max').click();
    await expect(summary(app, 'TEMP')).toHaveText('Max');
    await app.correction().click();
    await expect(summary(app, 'TEMP')).toHaveText('Max · corr.');
    await app.waitLoaded('temp');
    await app.expectDesktopBox();
});

test("the help opens on the tool's tab and closes with Escape and ×, returning focus", async ({ app, page }) => {
    const dialog = page.getByRole('dialog', { name: 'About Alpine planner' });

    async function openHelp(expectedTab: string): Promise<void> {
        await app.infoButton.click();
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('tab', { selected: true })).toHaveText(expectedTab);
    }

    async function closeHelp(how: 'Escape' | '×'): Promise<void> {
        if (how === 'Escape') {
            await page.keyboard.press('Escape');
        } else {
            await dialog.getByRole('button', { name: 'Close' }).click();
        }
        await expect(dialog).toBeHidden();
        await expect(app.infoButton).toBeFocused();
        await expect(app.panel, 'Escape closes only the help').toBeVisible();
    }

    await openHelp('Temp');
    await closeHelp('Escape');

    await app.selectTool('MASK');
    await openHelp('About'); // mask Off
    await closeHelp('×');

    await app.pill('Mask mode', 'Elevation').click();
    await openHelp('Elevation');
    await closeHelp('Escape');

    await app.pill('Mask mode', 'Isotherm').click();
    await openHelp('Isotherm');
    await closeHelp('×');
    await app.expectDesktopBox();
});

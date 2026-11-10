// Windy's mobile layout (project mobile-free, a phone profile): the small bottom pane, the isotherm settings popover,
// the two-line tab summaries.

import { test, expect, type App } from './fixtures';

async function isotherm(app: App): Promise<void> {
    await app.tab('MASK').tap();
    await expect(app.tab('MASK')).toHaveAttribute('aria-selected', 'true');
    await app.pill('Mask mode', 'Isotherm').tap();
}

test('the pane is at most 200 px tall in Isotherm Both with a window', async ({ app }) => {
    await isotherm(app);
    await app.pill('Isotherm mode', 'Both').tap();
    await expect(app.panel.getByRole('slider', { name: 'Window start' })).toBeVisible();
    await app.waitLoaded('mask');
    const { height } = await app.boxSize();
    expect(height).toBeGreaterThan(0);
    expect(height).toBeLessThanOrEqual(200);
});

test('the isotherm settings popover opens above the pane and closes with × and an outside tap', async ({ app, page }) => {
    await isotherm(app);
    const button = app.panel.getByTitle('Offset and lapse rate correction');
    const popover = page.getByRole('dialog', { name: 'Isotherm settings' });

    await button.tap();
    await expect(popover).toBeVisible();
    const pane = (await app.box.boundingBox())!;
    const above = (await popover.boundingBox())!;
    expect(above.y + above.height, 'the popover ends above the pane').toBeLessThanOrEqual(pane.y);
    await popover.getByRole('button', { name: 'Close' }).tap();
    await expect(popover).toBeHidden();

    await button.tap();
    await expect(popover).toBeVisible();
    // A tap on the map, above the popover
    await page.touchscreen.tap(page.viewportSize()!.width / 2, Math.max(above.y / 2, 80));
    await expect(popover).toBeHidden();
});

test('the tabs show two-line summaries', async ({ app }) => {
    for (const tool of ['TEMP', 'MASK'] as const) {
        const caption = (await app.tab(tool).locator('.alpine-planner__caption').boundingBox())!;
        const summary = (await app.tab(tool).locator('.alpine-planner__summary').boundingBox())!;
        expect(summary.y, `${tool}: the summary below the caption`).toBeGreaterThanOrEqual(caption.y + caption.height - 1);
        await expect(app.tab(tool).locator('.alpine-planner__summary')).not.toBeEmpty();
    }
});

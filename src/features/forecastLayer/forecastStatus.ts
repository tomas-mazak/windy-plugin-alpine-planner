// The forecast layer's status line in Min / Max. Pure, unit-tested (forecastStatus.test.ts); the time formatter is
// injected (Windy's formatWindyTime in the panel).

import { progressText, stepsText, type StepSelection } from '../../lib/steps.ts';

export type ForecastWindowStatus = {
    selection: StepSelection;
    loading: { loaded: number; needed: number } | null; // steps, over the data tiles in view
    failed: number; // the window's steps that failed in a tile in view
    premiumStart: number | null;
};

// "Timeline window · 12 steps, 3-hourly · loading 34/120 · 2 failed", plus
// "Free forecast ends Fri 00:00: 4 dropped" when the free forecast horizon cut the window.
// Algorithm: docs/forecast-layer-algorithm.md §2, §3
export function forecastWindowStatus(
    { selection, loading, failed, premiumStart }: ForecastWindowStatus,
    format: (ts: number) => string,
): string[] {
    const { steps, spacingH, clipped, dropped } = selection;
    const first = `Timeline window · ${stepsText(steps, spacingH)}${progressText(loading, failed)}`;
    return [first, ...(clipped && premiumStart ? [`Free forecast ends ${format(premiumStart)}: ${dropped} dropped`] : [])];
}

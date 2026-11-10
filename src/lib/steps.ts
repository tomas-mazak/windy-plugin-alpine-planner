// Which forecast steps a time window covers. Pure, unit-tested (steps.test.ts).
// Algorithm: docs/forecast-layer-algorithm.md §2

export type StepCalendar = {
    timestamps: number[]; // the model's output steps, ms, ascending
    premiumStart: number | null; // the free forecast horizon; null for free products
};

export type StepSelection = {
    steps: number[]; // ms, ascending; never empty for a non-empty calendar
    clipped: boolean; // free users: steps after premiumStart were dropped from the window
    dropped: number; // how many
    spacingH: number[]; // the distinct spacings between consecutive steps, hours, ascending
};

const HOUR = 3600 * 1000;

// The one premium-boundary rule, for Instant and the windows alike: a time is free for premium users, for free
// products (no premiumStart), and up to premiumStart included (a step exactly at it is free, as on Windy's timeline).
export const isFreeTime = (ts: number, premiumStart: number | null, premium: boolean): boolean =>
    premium || premiumStart === null || ts <= premiumStart;

// Every step with start ≤ t ≤ end. Free users lose the steps after premiumStart (isFreeTime). A window with no step
// inside takes the first step after start, or the last one.
export function selectSteps(
    calendar: StepCalendar,
    window: { start: number; end: number },
    premium: boolean,
): StepSelection {
    const { timestamps, premiumStart } = calendar;
    const free = (ts: number): boolean => isFreeTime(ts, premiumStart, premium);
    const inWindow = timestamps.filter(ts => ts >= window.start && ts <= window.end);
    let steps = inWindow.filter(free);
    const dropped = inWindow.length - steps.length;
    if (steps.length === 0) {
        const available = timestamps.filter(free);
        const fallback = available.find(ts => ts >= window.start) ?? available[available.length - 1];
        steps = fallback === undefined ? [] : [fallback];
    }
    const spacing = new Set<number>();
    for (let i = 1; i < steps.length; i++) {
        spacing.add(Math.round(((steps[i] - steps[i - 1]) / HOUR) * 100) / 100);
    }
    return { steps, clipped: dropped > 0, dropped, spacingH: [...spacing].sort((a, b) => a - b) };
}

// "5 steps, 3-hourly", "12 steps, 1–3-hourly", "1 step"
export function stepsText(steps: number[], spacingH: number[]): string {
    const count = `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`;
    if (spacingH.length === 0) {
        return count;
    }
    const spacing = spacingH.length === 1 ? `${spacingH[0]}` : `${spacingH[0]}–${spacingH[spacingH.length - 1]}`;
    return `${count}, ${spacing}-hourly`;
}

// The end of a window's status line: " · loading 34/120" while steps are missing, " · 2 failed" while any failed.
export const progressText = (loading: { loaded: number; needed: number } | null, failed: number): string =>
    (loading ? ` · loading ${loading.loaded}/${loading.needed}` : '') + (failed > 0 ? ` · ${failed} failed` : '');

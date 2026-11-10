// The isotherm mask's own time window (Min / Max / Both): both ends on the mask model's forecast steps, at most the
// free forecast horizon for free users. Pure, unit-tested (isoWindow.test.ts). The window's steps are
// selectSteps(calendar, window, premium) (src/lib/steps.ts).
// Algorithm: docs/freezing-mask-algorithm.md §6.2

import { isFreeTime } from '../../lib/steps.ts';

export type IsoWindow = {
    start: number; // ms, a step
    end: number; // ms, a step, ≥ start
    clipped: boolean; // the free forecast horizon cut the window's end
};

const HOUR = 3600 * 1000;
export const INITIAL_WINDOW_MS = 12 * HOUR;

// The steps the window may use: all, or for free users (a premiumLimit) those that are free (isFreeTime).
export const allowedSteps = (timestamps: number[], premiumLimit: number | null): number[] =>
    timestamps.filter(ts => isFreeTime(ts, premiumLimit, false));

// The step nearest ts, the earlier one on ties. `steps` is ascending and not empty.
function nearest(steps: number[], ts: number): number {
    let best = steps[0];
    for (const s of steps) {
        if (Math.abs(s - ts) < Math.abs(best - ts)) {
            best = s;
        }
    }
    return best;
}

// [the step nearest timestamp, the step nearest that + 12 h], both allowed; null without any allowed step.
export function initialWindow(timestamps: number[], timestamp: number, premiumLimit: number | null): IsoWindow | null {
    const allowed = allowedSteps(timestamps, premiumLimit);
    if (allowed.length === 0) {
        return null;
    }
    const start = nearest(allowed, timestamp);
    const wanted = start + INITIAL_WINDOW_MS;
    const end = Math.max(nearest(allowed, wanted), start);
    return { start, end, clipped: wanted > allowed[allowed.length - 1] && allowed.length < timestamps.length };
}

// A new run, another model or a premium change: the same absolute times, snapped to the nearest allowed steps and
// clipped to the first and last of them. null if the window doesn't overlap the allowed steps at all (the caller
// re-initialises it). A window already cut by the free horizon stays marked while its end is still the last free step.
export function clipWindow(window: IsoWindow, timestamps: number[], premiumLimit: number | null): IsoWindow | null {
    const allowed = allowedSteps(timestamps, premiumLimit);
    const first = allowed[0];
    const last = allowed[allowed.length - 1];
    if (allowed.length === 0 || window.end < first || window.start > last) {
        return null;
    }
    const clamp = (ts: number): number => Math.min(Math.max(ts, first), last);
    const start = nearest(allowed, clamp(window.start));
    const end = Math.max(nearest(allowed, clamp(window.end)), start);
    const free = allowed.length < timestamps.length;
    const cut = free && window.end > last;
    return { start, end, clipped: cut || (free && window.clipped && end === last) };
}

// Where a time sits on the window slider, 0 … 1: the slider is over step indices, so this interpolates between the
// neighbouring steps; a time outside the steps is clamped to the ends (the timeline tick).
export function sliderPosition(steps: number[], ts: number): number {
    const last = steps.length - 1;
    if (last < 1 || ts <= steps[0]) {
        return 0;
    }
    if (ts >= steps[last]) {
        return 1;
    }
    const i = steps.findIndex(s => s > ts) - 1;
    return (i + (ts - steps[i]) / (steps[i + 1] - steps[i])) / last;
}

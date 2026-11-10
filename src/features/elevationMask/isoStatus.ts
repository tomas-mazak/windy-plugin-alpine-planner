// The isotherm mask's status line and window label: what the mask is based on. Pure, unit-tested (isoStatus.test.ts);
// the time formatter is injected (Windy's formatWindyTime in the panel).

import { progressText, stepsText } from '../../lib/steps.ts';

export type TimeFormat = (ts: number) => string;

const HOUR = 3600 * 1000;

// The run as shown in the status line: '2026102606' → "ECMWF 06Z" (the run date goes to the tooltip).
export const runText = (name: string, refTime: string): string => `${name} ${refTime.slice(8, 10)}Z`;

// Instant: "Follows timeline · Tue 14:00 · ECMWF 06Z", plus " · loading …"
export const instantStatus = (run: string, timestamp: number, loading: boolean, format: TimeFormat): string =>
    `Follows timeline · ${format(timestamp)} · ${run}${loading ? ' · loading …' : ''}`;

export type WindowStatus = {
    run: string; // runText
    steps: number[]; // ms, ascending, not empty
    spacingH: number[]; // the distinct spacings, hours, ascending
    loading: { loaded: number; needed: number } | null; // steps, over the data tiles in view
    failed: number; // the window's steps that failed (or fell back to the uncorrected result) in a tile in view
    freeEnd: number | null; // premiumStart, when the free forecast horizon cut the window
    mobile: boolean; // one line only: the free note takes the run's place
};

// Min / Max / Both: "Fixed window · 5 steps, 3-hourly · ECMWF 06Z · loading 34/120 · 1 failed", plus
// "Free forecast ends Fri 00:00" when clipped. On mobile, clipped: "Fixed window · 5 steps, 3-hourly · free until
// Fri 00:00" (a second line overflows the pane; the run is in the tooltip).
export function windowStatus(
    { run, steps, spacingH, loading, failed, freeEnd, mobile }: WindowStatus,
    format: TimeFormat,
): string[] {
    const based = mobile && freeEnd !== null ? `free until ${format(freeEnd)}` : run;
    const first = `Fixed window · ${stepsText(steps, spacingH)} · ${based}${progressText(loading, failed)}`;
    return [first, ...(freeEnd !== null && !mobile ? [`Free forecast ends ${format(freeEnd)}`] : [])];
}

// "12 h", "1 d", "1 d 6 h"
export function durationText(ms: number): string {
    const h = Math.round(ms / HOUR);
    if (h < 24) {
        return `${h} h`;
    }
    return `${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ''}`;
}

// Above the window slider: "Tue 18:00 → Wed 06:00 · 12 h"
export const windowLabel = (start: number, end: number, format: TimeFormat): string =>
    `${format(start)} → ${format(end)} · ${durationText(end - start)}`;

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { allowedSteps, clipWindow, initialWindow, sliderPosition } from './isoWindow.ts';

const H = 3600 * 1000;
const T0 = Date.UTC(2026, 9, 26, 0);
const at = (h: number) => T0 + h * H;
// Hourly to +6 h, then 3-hourly to +48 h (as ICON / ECMWF mix their spacing).
const mixed = [...[0, 1, 2, 3, 4, 5, 6], ...Array.from({ length: 14 }, (_, i) => 9 + 3 * i)].map(at);
const threeHourly = Array.from({ length: 17 }, (_, i) => at(3 * i)); // 0 … 48 h

test('initial window: the start snaps to the nearest step, the end to the nearest step 12 h later', () => {
    assert.deepEqual(initialWindow(threeHourly, at(7.4), null), { start: at(6), end: at(18), clipped: false });
    assert.deepEqual(initialWindow(threeHourly, at(7.6), null), { start: at(9), end: at(21), clipped: false });
    // halfway between two steps: the earlier one
    assert.deepEqual(initialWindow(threeHourly, at(10.5), null), { start: at(9), end: at(21), clipped: false });
});

test('initial window: the 12 h end with mixed spacing', () => {
    // start 2 h (hourly part), 14 h falls between 12 and 15: nearest 15
    assert.deepEqual(initialWindow(mixed, at(2), null), { start: at(2), end: at(15), clipped: false });
    // start 5 h, 17 h: nearest 18
    assert.deepEqual(initialWindow(mixed, at(5.2), null), { start: at(5), end: at(18), clipped: false });
});

test('initial window: the end is never before the start; at the end of the forecast both are the last step', () => {
    assert.deepEqual(initialWindow(threeHourly, at(60), null), { start: at(48), end: at(48), clipped: false });
    assert.deepEqual(initialWindow(threeHourly, at(-30), null), { start: at(0), end: at(12), clipped: false });
    assert.equal(initialWindow([], at(0), null), null);
});

test('initial window: free users stop at premiumStart; a step exactly at premiumStart is free', () => {
    const limit = at(24);
    assert.deepEqual(initialWindow(threeHourly, at(18), limit), { start: at(18), end: at(24), clipped: true });
    assert.deepEqual(initialWindow(threeHourly, at(12), limit), { start: at(12), end: at(24), clipped: false });
    assert.deepEqual(initialWindow(threeHourly, at(30), limit), { start: at(24), end: at(24), clipped: true });
    // a horizon between steps: the last step before it
    assert.deepEqual(initialWindow(threeHourly, at(18), at(23)), { start: at(18), end: at(21), clipped: true });
});

test('clip: a new run keeps the absolute times', () => {
    const window = { start: at(9), end: at(21), clipped: false };
    const nextRun = threeHourly.map(ts => ts + 6 * H); // 6 … 54 h
    assert.deepEqual(clipWindow(window, nextRun, null), window);
    // a run starting later cuts the start
    const later = threeHourly.map(ts => ts + 12 * H); // 12 … 60 h
    assert.deepEqual(clipWindow(window, later, null), { start: at(12), end: at(21), clipped: false });
});

test('clip: another model snaps to its steps', () => {
    const window = { start: at(4), end: at(13), clipped: false };
    assert.deepEqual(clipWindow(window, threeHourly, null), { start: at(3), end: at(12), clipped: false });
    const hourly = Array.from({ length: 49 }, (_, i) => at(i));
    assert.deepEqual(clipWindow({ start: at(3), end: at(12), clipped: false }, hourly, null), {
        start: at(3),
        end: at(12),
        clipped: false,
    });
    // a short model (ICON-D2-like, 0 … 9 h): clipped to its last step
    assert.deepEqual(clipWindow(window, hourly.slice(0, 10), null), { start: at(4), end: at(9), clipped: false });
});

test('clip: the premium limit, and becoming premium', () => {
    const window = { start: at(18), end: at(30), clipped: false };
    const free = clipWindow(window, threeHourly, at(24));
    assert.deepEqual(free, { start: at(18), end: at(24), clipped: true });
    // still at the free horizon after a refresh: still marked
    assert.deepEqual(clipWindow(free!, threeHourly, at(24)), free);
    // premium: nothing to clip any more
    assert.deepEqual(clipWindow(free!, threeHourly, null), { start: at(18), end: at(24), clipped: false });
});

test('clip: no overlap with the available steps gives null', () => {
    assert.equal(clipWindow({ start: at(60), end: at(66), clipped: false }, threeHourly, null), null);
    assert.equal(clipWindow({ start: at(-12), end: at(-3), clipped: false }, threeHourly, null), null);
    assert.equal(clipWindow({ start: at(27), end: at(30), clipped: false }, threeHourly, at(24)), null);
    assert.equal(clipWindow({ start: at(0), end: at(3), clipped: false }, [], null), null);
});

test('slider position: by step index, interpolated, clamped to the ends', () => {
    // mixed: index 6 is +6 h, index 7 is +9 h, 20 steps after the first
    assert.equal(sliderPosition(mixed, at(0)), 0);
    assert.equal(sliderPosition(mixed, at(6)), 6 / 20);
    assert.equal(sliderPosition(mixed, at(7.5)), 6.5 / 20);
    assert.equal(sliderPosition(mixed, at(48)), 1);
    assert.equal(sliderPosition(mixed, at(-5)), 0);
    assert.equal(sliderPosition(mixed, at(100)), 1);
    assert.equal(sliderPosition([at(3)], at(5)), 0);
});

test('allowed steps: the step exactly at the free limit is allowed (the same rule as Instant)', () => {
    assert.deepEqual(allowedSteps(threeHourly, at(12)), threeHourly.slice(0, 5)); // 0 … 12 h
    assert.equal(allowedSteps(threeHourly, at(12) - 1).includes(at(12)), false);
    assert.deepEqual(allowedSteps(threeHourly, null), threeHourly);
});

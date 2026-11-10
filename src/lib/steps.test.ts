import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isFreeTime, selectSteps } from './steps.ts';

const H = 3600 * 1000;
const T0 = Date.UTC(2026, 9, 23, 0);
// Hourly to +6 h, then 3-hourly to +24 h.
const hourly = [0, 1, 2, 3, 4, 5, 6].map(h => T0 + h * H);
const threeHourly = [9, 12, 15, 18, 21, 24].map(h => T0 + h * H);
const calendar = { timestamps: [...hourly, ...threeHourly], premiumStart: null };
const at = (...hours: number[]) => hours.map(h => T0 + h * H);

test('both ends of the window are included', () => {
    const r = selectSteps(calendar, { start: T0 + 2 * H, end: T0 + 4 * H }, true);
    assert.deepEqual(r.steps, at(2, 3, 4));
    assert.equal(r.clipped, false);
    assert.deepEqual(r.spacingH, [1]);
});

test('a start between steps skips the step before it', () => {
    const r = selectSteps(calendar, { start: T0 + 7.5 * H, end: T0 + 15 * H }, true);
    assert.deepEqual(r.steps, at(9, 12, 15));
    assert.deepEqual(r.spacingH, [3]);
});

test('a fractional range ends between steps', () => {
    const r = selectSteps(calendar, { start: T0, end: T0 + 13.47 * H }, true);
    assert.deepEqual(r.steps, at(0, 1, 2, 3, 4, 5, 6, 9, 12));
    assert.deepEqual(r.spacingH, [1, 3]);
});

test('free users lose the steps after premiumStart; a step exactly at it stays', () => {
    const cal = { ...calendar, premiumStart: T0 + 12 * H };
    const free = selectSteps(cal, { start: T0 + 6 * H, end: T0 + 24 * H }, false);
    assert.deepEqual(free.steps, at(6, 9, 12));
    assert.equal(free.clipped, true);
    assert.equal(free.dropped, 4);
    const premium = selectSteps(cal, { start: T0 + 6 * H, end: T0 + 24 * H }, true);
    assert.deepEqual(premium.steps, at(6, 9, 12, 15, 18, 21, 24));
    assert.equal(premium.clipped, false);
    const before = selectSteps(cal, { start: T0, end: T0 + 6 * H }, false);
    assert.equal(before.clipped, false);
});

test('a window without a step takes the next step, or the last one', () => {
    assert.deepEqual(selectSteps(calendar, { start: T0 + 6.5 * H, end: T0 + 8 * H }, true).steps, at(9));
    assert.deepEqual(selectSteps(calendar, { start: T0 + 30 * H, end: T0 + 36 * H }, true).steps, at(24));
    const cal = { ...calendar, premiumStart: T0 + 12 * H };
    const r = selectSteps(cal, { start: T0 + 13 * H, end: T0 + 20 * H }, false);
    assert.deepEqual(r.steps, at(12));
    assert.equal(r.clipped, true);
});

test('mixed spacing is listed once per spacing', () => {
    const r = selectSteps(calendar, { start: T0, end: T0 + 24 * H }, true);
    assert.equal(r.steps.length, 13);
    assert.deepEqual(r.spacingH, [1, 3]);
    assert.deepEqual(selectSteps(calendar, { start: T0, end: T0 }, true).spacingH, []);
});

test('the premium boundary: a time exactly at premiumStart is free, a millisecond later is not', () => {
    const premiumStart = T0 + 12 * H;
    assert.equal(isFreeTime(premiumStart, premiumStart, false), true);
    assert.equal(isFreeTime(premiumStart + 1, premiumStart, false), false);
    assert.equal(isFreeTime(premiumStart + 1, premiumStart, true), true); // premium users
    assert.equal(isFreeTime(premiumStart + 1, null, false), true); // free products
    // The window agrees: a one-step window exactly at premiumStart keeps its step
    const one = selectSteps({ ...calendar, premiumStart }, { start: premiumStart, end: premiumStart }, false);
    assert.deepEqual(one.steps, [premiumStart]);
    assert.equal(one.clipped, false);
});

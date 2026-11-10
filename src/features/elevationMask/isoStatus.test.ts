import assert from 'node:assert/strict';
import { test } from 'node:test';

import { durationText, instantStatus, runText, windowLabel, windowStatus } from './isoStatus.ts';

const H = 3600 * 1000;
const T0 = Date.UTC(2026, 9, 27, 18); // Tue 18:00 UTC
const run = 'ECMWF 06Z';
// A stand-in for Windy's formatter: weekday and UTC time.
const format = (ts: number) => {
    const d = new Date(ts);
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
    return `${day} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
};
const at = (...hours: number[]) => hours.map(h => T0 + h * H);

test('the run: model and run hour', () => {
    assert.equal(runText('ECMWF', '2026102606'), 'ECMWF 06Z');
    assert.equal(runText('ICON-D2', '2026102700'), 'ICON-D2 00Z');
});

test('Instant: follows the timeline, Windy time and run; loading appended', () => {
    assert.equal(instantStatus(run, T0 - 4 * H, false, format), 'Follows timeline · Tue 14:00 · ECMWF 06Z');
    assert.equal(instantStatus(run, T0 - 4 * H, true, format), 'Follows timeline · Tue 14:00 · ECMWF 06Z · loading …');
});

test('a window: the steps and their spacing, the run', () => {
    const lines = windowStatus({ run, steps: at(0, 3, 6, 9, 12), spacingH: [3], loading: null, failed: 0, freeEnd: null, mobile: false }, format);
    assert.deepEqual(lines, ['Fixed window · 5 steps, 3-hourly · ECMWF 06Z']);
});

test('mixed spacing, and one step', () => {
    const mixed = windowStatus({ run, steps: at(0, 1, 2, 5), spacingH: [1, 3], loading: null, failed: 0, freeEnd: null, mobile: false }, format);
    assert.deepEqual(mixed, ['Fixed window · 4 steps, 1–3-hourly · ECMWF 06Z']);
    const one = windowStatus({ run, steps: at(0), spacingH: [], loading: null, failed: 0, freeEnd: null, mobile: false }, format);
    assert.deepEqual(one, ['Fixed window · 1 step · ECMWF 06Z']);
});

test('loading is appended', () => {
    const lines = windowStatus(
        { run, steps: at(0, 3, 6, 9, 12), spacingH: [3], loading: { loaded: 34, needed: 120 }, failed: 0, freeEnd: null, mobile: false },
        format,
    );
    assert.deepEqual(lines, ['Fixed window · 5 steps, 3-hourly · ECMWF 06Z · loading 34/120']);
});

test('failed steps are appended while any failed, after loading', () => {
    const steps = at(0, 3, 6, 9, 12);
    const loaded = windowStatus({ run, steps, spacingH: [3], loading: null, failed: 2, freeEnd: null, mobile: false }, format);
    assert.deepEqual(loaded, ['Fixed window · 5 steps, 3-hourly · ECMWF 06Z · 2 failed']);
    const loading = windowStatus({ run, steps, spacingH: [3], loading: { loaded: 3, needed: 10 }, failed: 1, freeEnd: null, mobile: false }, format);
    assert.deepEqual(loading, ['Fixed window · 5 steps, 3-hourly · ECMWF 06Z · loading 3/10 · 1 failed']);
});

test('clipped by the free forecast: a second line', () => {
    const lines = windowStatus({ run, steps: at(0, 3, 6), spacingH: [3], loading: null, failed: 0, freeEnd: T0 + 6 * H, mobile: false }, format);
    assert.deepEqual(lines, ['Fixed window · 3 steps, 3-hourly · ECMWF 06Z', 'Free forecast ends Wed 00:00']);
});

test('mobile, clipped: the free note takes the run\'s place on the one line', () => {
    const steps = at(0, 3, 6, 9, 12);
    const clipped = { run, steps, spacingH: [3], loading: null, failed: 0, freeEnd: T0 + 30 * H, mobile: true };
    assert.deepEqual(windowStatus(clipped, format), ['Fixed window · 5 steps, 3-hourly · free until Thu 00:00']);
    const failing = windowStatus({ ...clipped, failed: 1 }, format);
    assert.deepEqual(failing, ['Fixed window · 5 steps, 3-hourly · free until Thu 00:00 · 1 failed']);
    // not clipped: the run, as on desktop
    assert.deepEqual(windowStatus({ ...clipped, freeEnd: null }, format), ['Fixed window · 5 steps, 3-hourly · ECMWF 06Z']);
});

test('durations: hours below a day, then days and hours', () => {
    assert.equal(durationText(0), '0 h');
    assert.equal(durationText(12 * H), '12 h');
    assert.equal(durationText(24 * H), '1 d');
    assert.equal(durationText(30 * H), '1 d 6 h');
    assert.equal(durationText(72 * H), '3 d');
});

test('the window label: its ends and duration', () => {
    assert.equal(windowLabel(T0, T0 + 12 * H, format), 'Tue 18:00 → Wed 06:00 · 12 h');
    assert.equal(windowLabel(T0, T0 + 30 * H, format), 'Tue 18:00 → Thu 00:00 · 1 d 6 h');
});

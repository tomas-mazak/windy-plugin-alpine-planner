import assert from 'node:assert/strict';
import { test } from 'node:test';

import { forecastWindowStatus } from './forecastStatus.ts';

const H = 3600 * 1000;
const T0 = Date.UTC(2026, 9, 27, 18); // Tue 18:00 UTC
const format = (ts: number) => `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(ts).getUTCDay()]} ${new Date(ts).getUTCHours()}h`;
const twelve = { steps: Array.from({ length: 12 }, (_, k) => T0 + 3 * k * H), clipped: false, dropped: 0, spacingH: [3] };

test('the window: steps and spacing; loading, then failed steps on the same line', () => {
    const at = (loading: { loaded: number; needed: number } | null, failed: number) =>
        forecastWindowStatus({ selection: twelve, loading, failed, premiumStart: null }, format);
    assert.deepEqual(at(null, 0), ['Timeline window · 12 steps, 3-hourly']);
    assert.deepEqual(at({ loaded: 30, needed: 48 }, 0), ['Timeline window · 12 steps, 3-hourly · loading 30/48']);
    assert.deepEqual(at(null, 2), ['Timeline window · 12 steps, 3-hourly · 2 failed']);
    assert.deepEqual(at({ loaded: 30, needed: 48 }, 1), ['Timeline window · 12 steps, 3-hourly · loading 30/48 · 1 failed']);
});

test('clipped by the free forecast: a second line with the dropped steps', () => {
    const selection = { ...twelve, steps: twelve.steps.slice(0, 3), clipped: true, dropped: 9 };
    assert.deepEqual(forecastWindowStatus({ selection, loading: null, failed: 0, premiumStart: T0 + 6 * H }, format), [
        'Timeline window · 3 steps, 3-hourly',
        'Free forecast ends Wed 0h: 9 dropped',
    ]);
});

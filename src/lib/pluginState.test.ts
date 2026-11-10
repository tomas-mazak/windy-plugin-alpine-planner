import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultActivity, restoreState, serializeState, STATE_FRESH_MS, type PluginState } from './pluginState.ts';

const NOW = Date.UTC(2026, 10, 2, 12);
const MIN = 60 * 1000;

const used: PluginState = {
    values: { from: 1800, to: 2600, offset: 200 },
    activity: {
        tool: 'mask',
        temp: { mode: 'max', correction: true },
        mask: {
            mode: 'freezing',
            isoMode: 'both',
            isoCorrection: true,
            isoWindow: { start: NOW + 6 * 60 * MIN, end: NOW + 18 * 60 * MIN, clipped: false },
        },
    },
};

const DEFAULT_VALUES = { from: 1700, to: 8000, offset: 0 };

// The stored object, as serializeState writes it, with fields overridden.
const stored = (savedAt: number, patch: (s: Record<string, any>) => void = () => {}): string => {
    const s = JSON.parse(serializeState(used, savedAt));
    patch(s);
    return JSON.stringify(s);
};

test('a round trip: serialize, then restore while fresh', () => {
    assert.deepEqual(restoreState(serializeState(used, NOW), NOW + MIN), used);
});

test('the stored shape: version, savedAt, values, activity; the window with its clipped flag', () => {
    const s = JSON.parse(serializeState(used, NOW));
    assert.equal(s.v, 1);
    assert.equal(s.savedAt, NOW);
    assert.deepEqual(s.activity.mask.isoWindow, used.activity.mask.isoWindow);
});

test('a window clipped by the free horizon stays marked after a restore (the free forecast note)', () => {
    const clipped = { start: NOW, end: NOW + 6 * 60 * MIN, clipped: true };
    const state = { ...used, activity: { ...used.activity, mask: { ...used.activity.mask, isoWindow: clipped } } };
    assert.deepEqual(restoreState(serializeState(state, NOW), NOW + MIN).activity.mask.isoWindow, clipped);
    // a missing or invalid flag: not clipped
    const at = (isoWindow: unknown) => restoreState(stored(NOW, s => (s.activity.mask.isoWindow = isoWindow)), NOW).activity.mask;
    assert.equal(at({ start: 10, end: 20 }).isoWindow?.clipped, false);
    assert.equal(at({ start: 10, end: 20, clipped: 'yes' }).isoWindow?.clipped, false);
});

test('freshness at the boundary: 59 min 59 s fresh, 60 min stale, a future savedAt stale', () => {
    assert.equal(STATE_FRESH_MS, 60 * MIN);
    assert.deepEqual(restoreState(stored(NOW), NOW + 60 * MIN - 1000).activity, used.activity);
    assert.deepEqual(restoreState(stored(NOW), NOW + 60 * MIN).activity, defaultActivity());
    assert.deepEqual(restoreState(stored(NOW + MIN), NOW).activity, defaultActivity());
});

test('stale: the activity is the defaults, the values are kept', () => {
    const s = restoreState(stored(NOW - 61 * MIN), NOW);
    assert.deepEqual(s.activity, {
        tool: 'temp',
        temp: { mode: 'instant', correction: false },
        mask: { mode: 'off', isoMode: 'instant', isoCorrection: false, isoWindow: null },
    });
    assert.deepEqual(s.values, used.values);
});

test('each invalid field falls back alone', () => {
    const s = restoreState(
        stored(NOW, s => {
            s.activity.mask.isoMode = 'sometimes';
            s.activity.temp.correction = 'yes';
            s.activity.tool = 7;
            s.values.offset = 900;
        }),
        NOW,
    );
    assert.equal(s.activity.mask.isoMode, 'instant');
    assert.equal(s.activity.mask.mode, 'freezing'); // kept
    assert.equal(s.activity.temp.correction, false);
    assert.equal(s.activity.temp.mode, 'max'); // kept
    assert.equal(s.activity.tool, 'temp');
    assert.equal(s.values.offset, 0);
    assert.equal(s.values.from, 1800); // kept
});

test('values: out of range, gap broken, missing; rounded to the step', () => {
    const at = (values: unknown) => restoreState(stored(NOW, s => (s.values = values)), NOW).values;
    assert.deepEqual(at({ from: 100, to: 2600, offset: 50 }), { from: 1700, to: 2600, offset: 50 });
    assert.deepEqual(at({ from: 2600, to: 2650, offset: 0 }), DEFAULT_VALUES); // closer than the minimum gap
    assert.deepEqual(at({ from: 'x', to: null, offset: -600 }), DEFAULT_VALUES);
    assert.deepEqual(at(undefined), DEFAULT_VALUES);
    assert.deepEqual(at({ from: 1803, to: 2598, offset: -204 }), { from: 1800, to: 2600, offset: -200 });
});

test('an invalid window becomes none', () => {
    const at = (isoWindow: unknown) => restoreState(stored(NOW, s => (s.activity.mask.isoWindow = isoWindow)), NOW).activity.mask;
    assert.equal(at({ start: 'a', end: 2 }).isoWindow, null);
    assert.equal(at({ start: 10, end: 5 }).isoWindow, null);
    assert.equal(at(null).isoWindow, null);
    assert.equal(at({ start: 10, end: 10 }).isoWindow?.end, 10); // one step is a window
    assert.equal(at({ start: 'a', end: 2 }).isoMode, 'both'); // the rest is kept
});

test('corrupt JSON, a wrong version or nothing stored: the full defaults', () => {
    const defaults = { values: DEFAULT_VALUES, activity: defaultActivity() };
    assert.deepEqual(restoreState('{not json', NOW), defaults);
    assert.deepEqual(restoreState(stored(NOW, s => (s.v = 2)), NOW), defaults);
    assert.deepEqual(restoreState(null, NOW), defaults);
    assert.deepEqual(restoreState('null', NOW), defaults);
});

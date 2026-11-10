import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildProfile, FADE_DEPTH, profile, STANDARD_LAPSE_RATE, surfaceOffset, temperatureBelow } from './profile.ts';

// One node: [gh, T] per level.
const levels = (...l: [number, number][]) =>
    l.map(([gh, t]) => ({ gh: Float32Array.of(gh), tempC: Float32Array.of(t) }));
const near = (actual: number, expected: number, eps: number) =>
    assert.ok(Math.abs(actual - expected) <= eps, `${actual} is not within ${eps} of ${expected}`);

test('levels at or below z_s stay out of the profile, the highest kept aside; the rest sorted by height', () => {
    const n = buildProfile(0, 1000, 5, levels([1400, 1], [800, 9], [1000, 7], [2900, -8], [2000, -3]), 'tempC');
    assert.equal(n, 4);
    assert.deepEqual([...profile.z.subarray(0, n)], [1000, 1400, 2000, 2900]);
    assert.deepEqual([...profile.t.subarray(0, n)], [5, 1, -3, -8]);
    assert.deepEqual([profile.belowZ, profile.belowT], [1000, 7]);
});

test('levels without data are ignored', () => {
    assert.equal(buildProfile(0, 200, 10, levels([500, NaN], [1500, 2]), 'tempC'), 2);
    assert.equal(buildProfile(0, 200, 10, levels([NaN, 3]), 'tempC'), 1);
});

test('surface offset: linear at z_s between the levels just below and above it', () => {
    // Zermatt, Mon 26.10. 00 UTC (docs/forecast-layer-algorithm.md §7.3): 800 hPa below z_s, 700 hPa above
    const zermatt = levels([1516, 6.04], [2008, 2.88], [3073, -4.54], [4276, -9.83], [5661, -18.03]);
    buildProfile(0, 2931, -13.83, zermatt, 'tempC');
    const s = surfaceOffset();
    assert.ok(s.hasLevel);
    assert.equal(s.l0z, 3073);
    assert.deepEqual([s.belowZ, s.belowT], [2008, Math.fround(2.88)]);
    near(s.tFree, -3.55, 0.01);
    near(s.delta, 10.28, 0.01);
});

test('surface offset: without a level below z_s, the lowest level above continued down at 6.5 K/km', () => {
    buildProfile(0, 2931, -13.83, levels([3073, -4.54], [4276, -9.83]), 'tempC');
    const s = surfaceOffset();
    assert.ok(Number.isNaN(s.belowZ));
    near(s.tFree, -4.54 + 0.0065 * (3073 - 2931), 1e-5);
});

test('surface offset: continuous when a level crosses z_s', () => {
    // A level crossing the model terrain: from the lowest level above alone, a level at 999.9 m would be dropped and
    // T_free(z_s) would jump to the 1500 m level's, by 13.25 K
    const at500 = (lower: number) => {
        buildProfile(0, 1000, -5, levels([lower, -5], [1500, 5]), 'tempC');
        return temperatureBelow(-5, surfaceOffset().delta, 500);
    };
    assert.ok(Math.abs(at500(999.9) - at500(1000.1)) < 0.05);
});

test('surface offset: no level above z_s gives Δ = 0', () => {
    buildProfile(0, 2931, -13.83, levels([2008, 2.88]), 'tempC');
    const s = surfaceOffset();
    assert.equal(s.hasLevel, false);
    assert.equal(s.delta, 0);
    assert.equal(s.tFree, -13.83);
});

test('below the terrain: T2m at d = 0, the free air from 300 m, no jump at 300 m', () => {
    const [t2m, delta] = [-13.83, 10.21];
    assert.equal(temperatureBelow(t2m, delta, 0), t2m);
    near(temperatureBelow(t2m, delta, FADE_DEPTH), t2m + STANDARD_LAPSE_RATE * FADE_DEPTH + delta, 1e-9);
    near(temperatureBelow(t2m, delta, 1334), 5.05, 0.05); // Zermatt
    const step = (d: number) => Math.abs(temperatureBelow(t2m, delta, d + 0.5) - temperatureBelow(t2m, delta, d - 0.5));
    assert.ok(step(FADE_DEPTH) < 0.05); // 1 m within the fade changes T by Γ_s + Δ / 300 m ≈ 0.04 K
    assert.ok(Math.abs(temperatureBelow(t2m, delta, 0.5) - t2m) < 0.05);
});

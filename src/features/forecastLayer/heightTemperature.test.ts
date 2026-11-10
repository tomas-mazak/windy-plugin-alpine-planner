import assert from 'node:assert/strict';
import { test } from 'node:test';

import { STANDARD_LAPSE_RATE } from '../../lib/profile.ts';
import { temperatureAt, temperatureAtHeights } from './heightTemperature.ts';

const K = 273.15;
// One node: [gh (m), T (K)] per level.
const levels = (...l: [number, number][]) =>
    l.map(([gh, t]) => ({ gh: Float32Array.of(gh), tempK: Float32Array.of(t) }));
const celsius = (...l: [number, number][]) => levels(...l.map(([gh, t]): [number, number] => [gh, t + K]));
const at = (h: number, zs: number, t2m: number, l: ReturnType<typeof levels>) => temperatureAt(h, 0, zs, t2m, l);
const near = (actual: number, expected: number, eps = 1e-3) =>
    assert.ok(Math.abs(actual - expected) <= eps, `${actual} is not within ${eps} of ${expected}`);

// z_s 1000 m, T2m 280 K; 850 hPa at 1500 m, 700 hPa at 3000 m.
const ZS = 1000;
const T2M = 280;
const normal = levels([1500, 276], [3000, 266]);

// Zermatt (docs/forecast-layer-algorithm.md §7.3): point-interpolated inputs, z_s 2931 m, real height 1597 m. The
// below-ground 850 and 800 hPa never enter the profile; 800 hPa, the level just below z_s, sets T_free(z_s) with 700.
const ZERMATT = { zs: 2931, h: 1597 };
const BELOW = [[1516, 6.04], [2008, 2.88]] as [number, number][]; // 00 UTC

test('① Zermatt 00, 06 and 12 UTC: the free air with the surface offset faded out', () => {
    const cases: [number, [number, number][], number][] = [
        [-13.83, [[1516, 6.04], [2008, 2.88], [3073, -4.54], [4276, -9.83], [5661, -18.03]], 5.12],
        [-10.41, [[1516, 9.4], [2013, 6.18], [3090, -1.02]], 8.71],
        [-0.81, [[1533, 9.9], [2031, 6.71], [3110, -0.31]], 9.52],
    ];
    for (const [t2m, l, want] of cases) {
        const r = at(ZERMATT.h, ZERMATT.zs, t2m + K, celsius(...l));
        assert.equal(r.branch, 1);
        assert.equal(r.below?.z, l[1][0]);
        assert.equal(r.l0?.z, l[2][0]);
        assert.equal(r.w, 1);
        near(r.t - K, want, 0.05);
    }
});

test('① without a usable level: T2m + 6.5 K/km below z_s', () => {
    const r = at(600, ZS, T2M, levels([900, 279]));
    assert.equal(r.l0, null);
    assert.equal(r.below, null); // unused without L0
    assert.equal(r.delta, 0);
    near(r.t, T2M + STANDARD_LAPSE_RATE * 400);
});

test('② at and between levels', () => {
    near(at(1500, ZS, T2M, normal).t, 276);
    near(at(3000, ZS, T2M, normal).t, 266);
    const r = at(2250, ZS, T2M, normal);
    assert.equal(r.branch, 2);
    near(r.t, 271);
    near(at(1250, ZS, T2M, normal).t, 278);
});

test('③ above the top: 6.5 K/km from the top level', () => {
    const r = at(4000, ZS, T2M, normal);
    assert.equal(r.branch, 3);
    near(r.t, 266 - STANDARD_LAPSE_RATE * 1000);
});

// No jump: across 0.2 m the change stays within the profile's own slope (≤ ~40 K/km here, so ≤ 0.01 K).
test('continuous at z_s, at 300 m below it and at the top', () => {
    const cases: [number, number, ReturnType<typeof levels>][] = [
        [ZS, T2M, normal],
        [ZS, T2M, levels([1500, 290])], // warm level: Δ > 0
        [ZS, T2M, levels([1300, 278])],
        [ZERMATT.zs, -13.83 + K, celsius(...BELOW, [3073, -4.54])],
    ];
    for (const [zs, t2m, l] of cases) {
        for (const z of [zs, zs - 300, l[l.length - 1].gh[0]]) {
            assert.ok(Math.abs(at(z + 0.1, zs, t2m, l).t - at(z - 0.1, zs, t2m, l).t) <= 0.01, `at ${z}`);
        }
    }
});

test('nodata in z_s or T2m gives NaN; nodata levels are skipped', () => {
    assert.ok(Number.isNaN(at(500, NaN, T2M, normal).t));
    assert.ok(Number.isNaN(at(500, ZS, NaN, normal).t));
    near(at(2250, ZS, T2M, levels([1500, NaN], [3000, 266])).t, 280 - (14 * 1250) / 2000);
});

test('many heights at once equal one at a time', () => {
    const heights = Float64Array.from([-200, 600, 1000, 1200, 1500, 2700, 3000, 5000]);
    const out = new Float32Array(heights.length);
    temperatureAtHeights(0, ZS, T2M, normal, heights, out);
    heights.forEach((h, j) => near(out[j], at(h, ZS, T2M, normal).t));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    effectiveFreezingLevel,
    freezingNode,
    freezingTolerance,
    fTexels,
    type CorrectionData,
} from './freezingLevel.ts';

const steps = { deg0: 3.1, terrain: 3.2 }; // the Siberia reference tile, ECMWF z4
const tol = freezingTolerance(steps); // 11.3 m

// One node: deg0, terrain, and for the correction T2m (°C) plus [gh (m), temp (°C)] per level.
const node = (deg0: number, zs: number, correction: false | { t2m: number; levels?: [number, number][] }) =>
    freezingNode(
        0,
        Float32Array.of(deg0),
        Float32Array.of(zs),
        steps,
        correction && {
            t2mC: Float32Array.of(correction.t2m),
            levels: (correction.levels ?? []).map(([gh, t]) => ({ gh: Float32Array.of(gh), tempC: Float32Array.of(t) })),
        },
    );

const near = (actual: number, expected: number, eps: number) =>
    assert.ok(Math.abs(actual - expected) <= eps, `${actual} is not within ${eps} of ${expected}`);

// ECMWF run 2026101600, 74.9897° N 109.0258° E (docs/freezing-mask-algorithm.md §4): 950, 925, 850, 700 hPa
const SIBERIA_ZS = 213;
const SIBERIA_NOON = { t2m: -13.9, levels: [[372, -14.1], [574, -14.2], [1218, -13.1], [2688, -17.4]] as [number, number][] };
const SIBERIA_NIGHT = { t2m: -21.9, levels: [[453, -14.3], [656, -13.3], [1298, -14.3], [2762, -18.3]] as [number, number][] };

test('above ground: F = deg0', () => {
    assert.equal(node(2500, 1200, false).F, 2500);
    const r = node(2500, 1200, { t2m: 8, levels: [[1700, 5]] });
    assert.equal(r.F, 2500);
    assert.equal(r.branch, 'above ground');
});

test('correction off: F = z_s - tol', () => {
    const r = node(216, 216, false);
    near(r.F, 216 - tol, 1e-3);
    assert.equal(r.branch, 'ground (off)');
});

test('T2m >= 0: F = z_s - tol', () => {
    const r = node(1200, 1200, { t2m: 0.4, levels: [[1700, -3]] });
    near(r.F, 1200 - tol, 1e-3);
    assert.equal(r.branch, 'ground (T2m ≥ 0)');
});

// The crossing depth below z_s for T2m (°C) and a single level above z_s: [gh, T (°C)].
const free = (zs: number, t2m: number, level: [number, number]) => node(zs, zs, { t2m, levels: [level] });

test('Zermatt 00 UTC: the cold surface layer fades out, F in the free air ≈ 2385 m', () => {
    // docs/freezing-mask-algorithm.md §4: T_free(z_s) between 800 hPa (below z_s) and 700 hPa
    const levels: [number, number][] = [[1516, 6.04], [2008, 2.88], [3073, -4.54], [4276, -9.83], [5661, -18.03]];
    const r = node(2931, 2931, { t2m: -13.83, levels });
    assert.equal(r.branch, 'free air');
    near(r.delta, 10.28, 0.01);
    near(r.l0z, 3073, 1e-6);
    near(r.belowZ, 2008, 1e-6);
    near(r.F, 2385, 5);
});

test('Siberia: F far below the real terrain at night and at noon (free air); no level below z_s', () => {
    const night = node(216, SIBERIA_ZS, SIBERIA_NIGHT);
    assert.ok(Number.isNaN(night.belowZ));
    assert.equal(night.branch, 'free air');
    near(night.F, -1747, 10);
    const noon = node(216, SIBERIA_ZS, SIBERIA_NOON);
    assert.equal(noon.branch, 'free air');
    near(noon.F, -1798, 10);
});

test('fade: the crossing within 300 m below z_s', () => {
    // Δ = 0 (T2m on the free-air line): T2m −1 °C crosses at 1 / 0.0065 ≈ 154 m
    const r = free(1200, -1, [1700, -1 - 0.0065 * 500]);
    assert.equal(r.branch, 'fade');
    near(r.delta, 0, 1e-9);
    near(r.d0, 1 / 0.0065, 1e-6);
    near(r.F, 1200 - 1 / 0.0065, 1e-3);
});

test('d0 is continuous where the crossing moves from the fade to the free air', () => {
    // T_300 = T2m + 1.95 + Δ = 0 at T2m = −1.95 − Δ; with Δ = +2: T2m = −3.95
    let previous = NaN;
    for (let t2m = -3.9; t2m >= -4.0; t2m -= 0.001) {
        const r = free(1200, t2m, [1700, t2m + 2 - 0.0065 * 500]);
        if (!Number.isNaN(previous)) {
            assert.ok(Math.abs(r.d0 - previous) < 0.5, `jump at T2m ${t2m}`);
        }
        previous = r.d0;
    }
});

test('a warm surface (Δ < 0) still crosses, a node without a level uses Δ = 0', () => {
    const warm = free(1200, -1, [1700, -8]); // sun-heated ground: the free air (−4.75 °C at z_s) colder than T2m
    assert.ok(warm.delta < 0);
    assert.ok(Number.isFinite(warm.F) && warm.F < 1200);
    const none = node(1200, 1200, { t2m: -2, levels: [[1100, -1], [800, 1]] });
    assert.equal(none.noLevel, true);
    assert.equal(none.delta, 0);
    near(none.F, 1200 - 2 / 0.0065, 1e-3);
});

test('unsorted levels give the same result', () => {
    const a = node(1200, 1200, { t2m: -2, levels: [[1500, -4], [1900, -6]] });
    const b = node(1200, 1200, { t2m: -2, levels: [[1900, -6], [1500, -4]] });
    assert.equal(a.F, b.F);
    near(a.l0z, 1500, 1e-6);
});

test('nodata: a level is ignored, T2m gives nodata', () => {
    const withNodataLevel = node(1200, 1200, { t2m: -2, levels: [[NaN, -1], [1600, NaN], [1700, -5]] });
    near(withNodataLevel.l0z, 1700, 1e-6);
    assert.ok(Number.isNaN(node(1200, 1200, { t2m: NaN, levels: [[1700, -5]] }).F));
    assert.ok(Number.isNaN(node(NaN, 1200, false).F));
    assert.ok(Number.isNaN(node(1200, NaN, false).F));
});

test('F texture: a nodata node takes a valid neighbour\'s F, so a 3000 m node next to it stays 3000 m', () => {
    // Row 0: a 3000 m node (F_min 2800) next to nodata; the bilinear filter halfway between them used to read 1500 m
    const n = 257 * 257;
    const fMin = new Float32Array(n).fill(NaN);
    const fMax = new Float32Array(n).fill(NaN);
    fMin[0] = 2800;
    fMax[0] = 3000;
    const rgba = fTexels(fMin, fMax, null);
    assert.deepEqual([...rgba.subarray(0, 4)], [2800, 3000, 0, 0]);
    assert.deepEqual([...rgba.subarray(4, 8)], [2800, 3000, 1, 0]); // node 1: filled, still nodata
    assert.equal((rgba[1] + rgba[5]) / 2, 3000); // halfway
    assert.deepEqual([...rgba.subarray(4 * 257, 4 * 257 + 4)], [2800, 3000, 1, 0]); // below it, too
    // No valid neighbour: 0, nodata
    assert.deepEqual([...rgba.subarray(4 * 2, 4 * 2 + 4)], [0, 0, 1, 0]);
    // A window's nodata mask: nodata in one step even where F_min / F_max are finite
    const mask = new Uint8Array(n);
    mask[1] = 1;
    const window = fTexels(Float32Array.from({ length: n }, () => 1000), Float32Array.from({ length: n }, () => 2000), mask);
    assert.deepEqual([...window.subarray(4, 8)], [1000, 2000, 1, 0]);
});

test('performance: a full screen of tiles', () => {
    const n = 257 * 257;
    const tiles = 24; // a 1920 × 1080 view at 256 px tiles is ≈ 8 × 5, but deg0 tiles cover more; generous
    const grid = (f: (i: number) => number) => Float32Array.from({ length: n }, (_, i) => f(i));
    const deg0 = grid(i => 1000 + (i % 300)); // about half the nodes at the ground
    const terrain = grid(i => 1150 + (i % 7));
    const levelHeights = [500, 750, 1000, 1500, 2000, 3000, 4200, 5600];
    const correction: CorrectionData = {
        t2mC: grid(i => -3 + (i % 5)),
        levels: levelHeights.map((h, k) => ({ gh: grid(i => h + (i % 11)), tempC: grid(() => 5 - 6.5 * (k + 1)) })),
    };
    const start = performance.now();
    for (let t = 0; t < tiles; t++) {
        effectiveFreezingLevel(deg0, terrain, steps, correction);
    }
    const ms = performance.now() - start;
    console.log(`  effectiveFreezingLevel: ${tiles} tiles × 66 049 nodes, 8 levels: ${ms.toFixed(1)} ms`);
    assert.ok(ms < 2000);
});

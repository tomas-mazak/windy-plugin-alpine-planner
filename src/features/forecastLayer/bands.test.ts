import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    BAND_SPACING,
    bandFoldRange,
    bandRange,
    createBandFold,
    foldStepNodes,
    levelsForRange,
    MAX_BANDS,
    STANDARD_HEIGHTS,
    WIDE_BAND_SPACING,
    type BandFold,
    type Bands,
} from './bands.ts';
import { temperatureAt } from './heightTemperature.ts';

const ALL = ['950h', '925h', '900h', '850h', '800h', '700h', '600h', '500h'];

// The offsets of a tile's bands, and the heights of node zs's bands.
const offsets = ({ oLo, S, K }: Bands) => Array.from({ length: K }, (_, k) => oLo + k * S);
const heightsAt = (bands: Bands, zs: number) => offsets(bands).map(o => zs + o);

// The band reconstruction at height h for one node, as the shader does it at a node: linear between the two bands
// around h − z_s, the nearest band outside.
function reconstruct(fold: BandFold, i: number, zs: number, h: number): number {
    const { oLo, S, K } = fold.bands;
    const pos = Math.min(Math.max((h - zs - oLo) / S, 0), K - 1);
    const k0 = Math.min(Math.floor(pos), K - 2);
    const [v0, v1] = [fold.value[k0 * fold.size + i], fold.value[(k0 + 1) * fold.size + i]];
    return v0 + (v1 - v0) * (pos - k0);
}

// One step of a one-node tile: z_s, T2m and [gh, T] levels, all K.
const oneNode = (zs: number, t2m: number, levels: [number, number][]) => ({
    zs: Float32Array.of(zs),
    t2m: Float32Array.of(t2m),
    levels: levels.map(([gh, t]) => ({ gh: Float32Array.of(gh), tempK: Float32Array.of(t) })),
});

function foldOne(bands: Bands, step: ReturnType<typeof oneNode>): BandFold {
    const fold = createBandFold('max', bands, 1);
    foldStepNodes(fold, step, 0, 1, new Float32Array(bands.K));
    return fold;
}

test('band range: multiples of 150 m from below the lowest real terrain to above the highest, 0 and −300 included', () => {
    // Alps-like: model terrain 400 … 2600 m, real 300 … 3200 m: offsets from 100 − 2600 down to −2550, up to
    // 4700 − 400 = 4300, 4350 as a multiple of 150: 47 bands
    const alps = bandRange(400, 2600, 300, 3200);
    assert.deepEqual([alps.oLo, alps.S, alps.K], [-2550, BAND_SPACING, 47]);
    // Flat: model terrain 100 … 120 m, real 90 … 140 m: −230 → −300 (the end of the fade is always a band), 1540 → 1650
    const flat = bandRange(100, 120, 90, 140);
    assert.deepEqual([flat.oLo, flat.S, flat.K], [-300, BAND_SPACING, 14]);
    for (const bands of [alps, flat]) {
        assert.ok(offsets(bands).includes(0) && offsets(bands).includes(-300));
        assert.ok(bands.K <= MAX_BANDS);
    }
});

test('band range: 300 m apart when 150 m would need more than 48 bands; heights within −500 … 9000 m', () => {
    // Model terrain 200 … 4200 m, real 100 … 4800 m: 150 m would need (6300 + 4200) / 150 + 1 = 71 bands
    const wide = bandRange(200, 4200, 100, 4800);
    assert.equal(wide.S, WIDE_BAND_SPACING);
    assert.deepEqual([wide.oLo, wide.K], [-4500, 37]); // −100 − 4200 → −4500, 6100 → 6300
    assert.ok(offsets(wide).includes(0) && offsets(wide).includes(-300));
    // At the limit: −300 … 6750 m is 48 bands at 150 m, a metre more needs 49
    assert.equal(bandRange(0, 0, 200, 5250).K, 48);
    assert.equal(bandRange(0, 0, 200, 5251).S, WIDE_BAND_SPACING);
    // The sea and the ceiling: no band needed below −500 m or above 9000 m
    const sea = bandRange(-600, -400, -900, -800);
    assert.equal(sea.oLo, -300); // −500 − (−400) = −100, then −300 at least
    const high = bandRange(8000, 8500, 8000, 8800);
    assert.equal(high.oLo + high.S * (high.K - 1), 1050); // 9000 − 8000 = 1000, rounded up
    assert.equal(high.hi, 9000);
});

test("bands at the model terrain: a surface inversion is exact at z_s and at z_s − 300 m", () => {
    // z_s 2000 m, T2m −1.5 °C under +4 °C at 2100 m (a surface inversion), tile range 500 … 4000 m. With bands at
    // fixed heights it read +2.85 °C at z_s.
    const C = 273.15;
    const step = oneNode(2000, -1.5 + C, [[2100, 4 + C], [3000, -2 + C]]);
    const fold = foldOne(bandRange(2000, 2000, 500, 4000), step);
    const exact = (h: number) => temperatureAt(h, 0, 2000, -1.5 + C, step.levels).t;
    assert.ok(Math.abs(reconstruct(fold, 0, 2000, 2000) - (-1.5 + C)) <= 0.05);
    assert.ok(Math.abs(reconstruct(fold, 0, 2000, 1700) - exact(1700)) <= 0.05);
});

test('bands: a 20 K/km corner at a pressure level costs at most ΔΓ · S / 4 = 0.75 K', () => {
    // Flat up to a level 75 m above z_s (between two bands), then +20 K/km
    const C = 273.15;
    const step = oneNode(1000, C, [[1075, C], [2075, 20 + C]]);
    const bands = bandRange(1000, 1000, 900, 1500);
    const fold = foldOne(bands, step);
    let worst = 0;
    for (let h = 700; h <= 2000; h += 5) {
        const exact = temperatureAt(h, 0, 1000, C, step.levels).t;
        worst = Math.max(worst, Math.abs(reconstruct(fold, 0, 1000, h) - exact));
    }
    assert.ok(worst <= 0.75 + 1e-3, `${worst}`);
    assert.ok(worst > 0.7); // the bound is reached at the corner
});

test('levels: Alps and lowland ranges start at the lowest model terrain', () => {
    // Model terrain 400 … 2600 m: [400 − 600, 4700 + 600] = [−200, 5300]: all up to 600 hPa, plus 500 beyond
    const alps = bandRange(400, 2600, 300, 3200);
    assert.deepEqual(levelsForRange(400, alps.hi, ALL), ALL);
    // Lowlands: [−500, 2240]: 950 … 800, plus 700 beyond
    const lowland = bandRange(100, 120, 90, 140);
    assert.deepEqual(levelsForRange(100, lowland.hi, ALL), ['950h', '925h', '900h', '850h', '800h', '700h']);
});

test('levels: a high tile skips the levels below its model terrain', () => {
    // Model terrain 2200 … 3400 m over valleys at 1300 m: [1600, hi + 600]. 800 hPa is the first inside, 850 the one
    // beyond; 950 … 900 hPa (≤ ~1000 m) lie below the model terrain everywhere and aren't fetched.
    const valais = bandRange(2200, 3400, 1300, 4000);
    const levels = levelsForRange(2200, valais.hi, ALL);
    assert.deepEqual(levels, ['850h', '800h', '700h', '600h', '500h']);
    assert.ok(!levels.includes('900h') && !levels.includes('925h') && !levels.includes('950h'));
});

test("levels: the level just below every node's model terrain is fetched", () => {
    // Real level heights within ± 300 m of the standard ones: the highest level at or below the tile's lowest model
    // terrain (every node's level below is at least as high) is always among the fetched ones.
    for (let zsMin = -300; zsMin <= 6000; zsMin += 25) {
        const fetched = levelsForRange(zsMin, zsMin + 2000, ALL);
        for (const shift of [-300, 0, 300]) {
            const below = ALL.filter(l => STANDARD_HEIGHTS[l] + shift <= zsMin).pop();
            assert.ok(below === undefined || fetched.includes(below), `z_s ${zsMin}, shift ${shift}: ${below}`);
        }
    }
});

test('levels: one beyond each end, at the ends of the available list', () => {
    assert.deepEqual(levelsForRange(2000, 2100, ['950h', '500h']), ['950h', '500h']); // none inside: the neighbours
    assert.deepEqual(levelsForRange(8000, 8500, ALL), ['500h']); // all below: the highest
    assert.deepEqual(levelsForRange(-500, -400, ['850h', '700h']), ['850h']); // all above: the lowest
    assert.deepEqual(levelsForRange(0, 1000, ['925h', '850h', 'surface']), ['925h', '850h']);
    assert.deepEqual(levelsForRange(0, 1000, []), []);
});

test("band fold: max / min over steps at each node's band equals the exact per-height extreme", () => {
    const size = 2;
    const bands = bandRange(900, 1100, 800, 1200);
    const step = (t2m: number[], l850: [number, number][]) => ({
        zs: Float32Array.of(900, 1100),
        t2m: Float32Array.from(t2m),
        levels: [{ gh: Float32Array.from(l850.map(l => l[0])), tempK: Float32Array.from(l850.map(l => l[1])) }],
    });
    const steps = [step([280, 279], [[1500, 276], [1500, 270]]), step([275, 283], [[1500, 280], [1500, 271]])];
    for (const kind of ['max', 'min'] as const) {
        const fold = createBandFold(kind, bands, size);
        const scratch = new Float32Array(bands.K);
        steps.forEach(s => foldStepNodes(fold, s, 0, size, scratch));
        for (let i = 0; i < size; i++) {
            heightsAt(bands, steps[0].zs[i]).forEach((h, k) => {
                const exact = steps.map(s => temperatureAt(h, i, s.zs[i], s.t2m[i], s.levels).t);
                const want = kind === 'max' ? Math.max(...exact) : Math.min(...exact);
                assert.ok(Math.abs(fold.value[k * size + i] - want) < 1e-3, `${kind} node ${i} band ${k}`);
            });
        }
    }
});

test('band fold: nodata in any step, and the range of the valid nodes', () => {
    const bands = bandRange(0, 0, 0, 0);
    const fold = createBandFold('max', bands, 2);
    const scratch = new Float32Array(bands.K);
    const levels = [{ gh: Float32Array.of(1000, 1000), tempK: Float32Array.of(270, 270) }];
    foldStepNodes(fold, { zs: Float32Array.of(0, 0), t2m: Float32Array.of(280, 281), levels }, 0, 2, scratch);
    foldStepNodes(fold, { zs: Float32Array.of(0, NaN), t2m: Float32Array.of(282, 281), levels }, 0, 2, scratch);
    assert.deepEqual([...fold.nodata], [0, 1]);
    const node0 = Array.from({ length: bands.K }, (_, k) => fold.value[k * 2]);
    assert.deepEqual(bandFoldRange(fold), [Math.min(...node0), Math.max(...node0)]);
});

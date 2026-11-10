// Height bands: a data tile's corrected values at K heights relative to each node's own model terrain, which pressure
// levels a tile needs, and the min/max fold of corrected steps per band. Kelvin. Pure and framework-free (node:test).

import { FADE_DEPTH } from '../../lib/profile.ts';
import { temperatureAtHeights, type HeightLevel } from './heightTemperature.ts';

import type { FoldKind } from './fold.ts';

export const BAND_FLOOR = -500; // m: target terrain range floor, before deriving shared relative offsets
export const BAND_CEILING = 9000; // m: target terrain range ceiling; individual node bands can extend beyond it
export const BAND_SPACING = 150; // m: a multiple of it at 0 and −FADE_DEPTH, the profile's sharpest corners
export const WIDE_BAND_SPACING = 300; // m: when BAND_SPACING would need more than MAX_BANDS
export const MAX_BANDS = 48; // spacing-switch threshold, not a hard cap on the final count
export const BELOW_TERRAIN = 200; // m below the lowest real terrain
export const ABOVE_REAL_TERRAIN = 1500; // m above the averaged real terrain maximum: its summits are higher
export const LEVEL_MARGIN = 600; // m around the band range: real level heights vary with the weather

// The standard-atmosphere height of each profile level (m).
export const STANDARD_HEIGHTS: Record<string, number> = {
    '950h': 540,
    '925h': 762,
    '900h': 988,
    '850h': 1457,
    '800h': 1949,
    '700h': 3012,
    '600h': 4206,
    '500h': 5574,
};

// Node i's band k sits at z_s,i + oLo + k · S. hi: the highest height needed over the tile (m), for the levels.
export type Bands = { oLo: number; S: number; K: number; hi: number };

// The band offsets for a tile, from its model terrain range and its real terrain range (m): from the lowest real
// terrain under the highest model terrain to the top over the lowest one, in multiples of S, so the offsets 0 and
// −300 m (the corners at z_s and at the end of the fade) are always bands.
// Algorithm: docs/forecast-layer-algorithm.md §7.5
export function bandRange(zsMin: number, zsMax: number, eMin: number, eMax: number): Bands {
    const bottom = Math.max(eMin - BELOW_TERRAIN, BAND_FLOOR);
    const top = Math.min(eMax + ABOVE_REAL_TERRAIN, BAND_CEILING);
    const range = (S: number) => {
        const oLo = Math.min(Math.floor((bottom - zsMax) / S) * S, -FADE_DEPTH);
        const oHi = Math.max(Math.ceil((top - zsMin) / S) * S, 0);
        return { oLo, S, K: (oHi - oLo) / S + 1, hi: Math.max(top, zsMax) };
    };
    const narrow = range(BAND_SPACING);
    return narrow.K <= MAX_BANDS ? narrow : range(WIDE_BAND_SPACING);
}

// The levels to fetch for a tile, by height: those whose standard height lies in [zsMin − 600 m, hi + 600 m], plus
// one beyond each end where there is one. Below the model terrain only the levels just above and below it are used, so
// the range starts at the tile's lowest model terrain zsMin, and the one beyond the low end is the level just below it.
// Only levels in `available` (the model's) are considered.
// Algorithm: docs/forecast-layer-algorithm.md §7.7
export function levelsForRange(zsMin: number, hi: number, available: readonly string[]): string[] {
    const height = (l: string): number => STANDARD_HEIGHTS[l];
    const levels = available.filter(l => l in STANDARD_HEIGHTS).sort((a, b) => height(a) - height(b));
    let first = levels.findIndex(l => height(l) >= zsMin - LEVEL_MARGIN); // the lowest level not below the range
    let last = levels.length - 1;
    while (last >= 0 && height(levels[last]) > hi + LEVEL_MARGIN) {
        last--; // the highest level not above the range
    }
    first = first < 0 ? levels.length : first;
    // One beyond each end; with none inside, that's the levels just below and above the range.
    return levels.slice(Math.max(first - 1, 0), Math.min(last + 1, levels.length - 1) + 1);
}

// One step's inputs for a tile: model terrain z_s (m), T2m (K) and the fetched levels, all NaN where no data.
export type CorrectedStep = { zs: Float32Array; t2m: Float32Array; levels: HeightLevel[] };

export type BandFold = {
    kind: FoldKind;
    bands: Bands;
    value: Float32Array; // K, band-major: value[k * size + i]; ±Infinity until a step is added
    nodata: Uint8Array; // 1: z_s or T2m nodata in at least one step
    size: number;
};

export function createBandFold(kind: FoldKind, bands: Bands, size = 257 * 257): BandFold {
    const value = new Float32Array(bands.K * size).fill(kind === 'max' ? -Infinity : Infinity);
    return { kind, bands, value, nodata: new Uint8Array(size), size };
}

// A node's band heights, reused: no allocation per node.
let heights = new Float64Array(MAX_BANDS);

// Corrects nodes [from, to) of one step at each node's band heights z_s + o_k and folds them into the bands (max or
// min per band). Called in slices; `scratch` holds K values.
// Algorithm: docs/forecast-layer-algorithm.md §7.4, §7.5
export function foldStepNodes(
    fold: BandFold,
    step: CorrectedStep,
    from: number,
    to: number,
    scratch: Float32Array,
): void {
    const { kind, bands, value, nodata, size } = fold;
    const { oLo, S, K } = bands;
    if (heights.length < K) {
        heights = new Float64Array(K);
    }
    const h = heights.subarray(0, K);
    for (let i = from; i < to; i++) {
        for (let k = 0; k < K; k++) {
            h[k] = step.zs[i] + oLo + k * S;
        }
        temperatureAtHeights(i, step.zs[i], step.t2m[i], step.levels, h, scratch);
        if (Number.isNaN(scratch[0])) {
            nodata[i] = 1;
            continue;
        }
        for (let k = 0, j = i; k < bands.K; k++, j += size) {
            const v = scratch[k];
            if (kind === 'max' ? v > value[j] : v < value[j]) {
                value[j] = v;
            }
        }
    }
}

// [min, max] over the valid nodes and all bands (K), null if none: the colour pass clamps to it.
// Algorithm: docs/forecast-layer-algorithm.md §4, §7.6
export function bandFoldRange({ value, nodata, size, bands }: BandFold): [number, number] | null {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < size; i++) {
        if (nodata[i]) {
            continue;
        }
        for (let k = 0, j = i; k < bands.K; k++, j += size) {
            if (Number.isFinite(value[j])) {
                lo = Math.min(lo, value[j]);
                hi = Math.max(hi, value[j]);
            }
        }
    }
    return lo <= hi ? [lo, hi] : null;
}

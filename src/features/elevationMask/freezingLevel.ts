// The effective freezing level F (docs/freezing-mask-algorithm.md). deg0 is floored at the model's smoothed terrain,
// so where it's frozen to the ground it equals the model terrain while the real terrain is often lower. With the
// lapse rate correction, the temperature below the model terrain follows the free air (from the levels just below and
// above it, continued down at the standard lapse rate) with the model's surface offset fading out over FADE_DEPTH, and F is
// where that reaches 0 °C, per grid node.
// Pure and framework-free, so it's unit-tested with node:test (freezingLevel.test.ts). The profile and the rule below
// the terrain are shared with the forecast layer (src/lib/profile.ts). Temperatures here are °C.

import { validNeighbour } from '../../lib/grid.ts';
import { buildProfile, FADE_DEPTH, STANDARD_LAPSE_RATE, surfaceOffset } from '../../lib/profile.ts';

export type FreezingSteps = { deg0: number; terrain: number };

// The pressure levels above the model terrain: temperature (°C) and geopotential height (m), NaN = no data.
export type CorrectionData = { t2mC: Float32Array; levels: { tempC: Float32Array; gh: Float32Array }[] };

export type Branch = 'above ground' | 'ground (off)' | 'ground (T2m ≥ 0)' | 'fade' | 'free air';

// One node's result. With the correction's branches (fade, free air): the lowest level above z_s (l0z, l0t; NaN and
// noLevel without one), the highest level at or below it (belowZ, belowT; NaN without one), T_free(z_s), the surface offset delta (K) and the crossing depth d0 below z_s (m); NaN
// otherwise.
export type FreezingNode = {
    F: number;
    branch: Branch;
    noLevel: boolean;
    l0z: number;
    l0t: number;
    belowZ: number;
    belowT: number;
    tFree: number;
    delta: number;
    d0: number;
};

export const emptyNode = (): FreezingNode => ({
    F: NaN,
    branch: 'above ground',
    noLevel: false,
    l0z: NaN,
    l0t: NaN,
    belowZ: NaN,
    belowT: NaN,
    tFree: NaN,
    delta: NaN,
    d0: NaN,
});

// Metres; covers the 8-bit rounding of both values.
// Algorithm: docs/freezing-mask-algorithm.md §3
export const freezingTolerance = (steps: FreezingSteps): number => steps.deg0 + steps.terrain + 5;

// Algorithm: docs/freezing-mask-algorithm.md §4
// Evaluates node i into `out`. Nodata (NaN) in deg0, terrain or T2m gives F = NaN.
export function freezingNode(
    i: number,
    deg0: Float32Array,
    terrain: Float32Array,
    steps: FreezingSteps,
    correction: CorrectionData | false,
    out: FreezingNode = emptyNode(),
): FreezingNode {
    const d = deg0[i];
    const zs = terrain[i];
    const t2m = correction ? correction.t2mC[i] : 0;
    const tol = freezingTolerance(steps);
    out.noLevel = false;
    out.l0z = out.l0t = out.belowZ = out.belowT = out.tFree = out.delta = out.d0 = NaN;
    if (Number.isNaN(d) || Number.isNaN(zs) || Number.isNaN(t2m)) {
        out.F = NaN;
        out.branch = 'above ground';
    } else if (d > zs + tol) {
        out.F = d;
        out.branch = 'above ground';
    } else if (!correction) {
        out.F = zs - tol;
        out.branch = 'ground (off)';
    } else if (t2m >= 0) {
        out.F = zs - tol;
        out.branch = 'ground (T2m ≥ 0)';
    } else {
        buildProfile(i, zs, t2m, correction.levels, 'tempC');
        const surface = surfaceOffset();
        const delta = surface.delta;
        // T 300 m below the terrain; within the fade T rises linearly from T2m < 0, below it at Γ_s > 0
        const t300 = t2m + STANDARD_LAPSE_RATE * FADE_DEPTH + delta;
        const fade = t300 >= 0;
        out.d0 = fade ? -t2m / (STANDARD_LAPSE_RATE + delta / FADE_DEPTH) : FADE_DEPTH - t300 / STANDARD_LAPSE_RATE;
        out.branch = fade ? 'fade' : 'free air';
        out.F = zs - out.d0;
        out.noLevel = !surface.hasLevel;
        out.l0z = surface.l0z;
        out.l0t = surface.l0t;
        out.belowZ = surface.belowZ;
        out.belowT = surface.belowT;
        out.tFree = surface.tFree;
        out.delta = delta;
    }
    return out;
}

// Algorithm: docs/freezing-mask-algorithm.md §5
// F for every node of a tile, or for the nodes [from, to) into `out` (the window's fold computes a step in row chunks).
export function effectiveFreezingLevel(
    deg0: Float32Array,
    terrain: Float32Array,
    steps: FreezingSteps,
    correction: CorrectionData | false,
    out: Float32Array = new Float32Array(deg0.length),
    from = 0,
    to = deg0.length,
): Float32Array {
    const node = emptyNode();
    for (let i = from; i < to; i++) {
        out[i] = freezingNode(i, deg0, terrain, steps, correction, node).F;
    }
    return out;
}

// The F texture's texels, RGBA: R = F_min, G = F_max (m), B = nodata (1). A null nodata mask means nodata where fMin
// is NaN. A nodata node takes F_min and F_max from a valid neighbour (none: 0, it's dimmed anyway), so the bilinear
// filter doesn't mix a meaningless 0 m into the valid nodes near a domain edge; B is interpolated separately.
// Algorithm: docs/freezing-mask-algorithm.md §5, §6.3
export function fTexels(fMin: Float32Array, fMax: Float32Array, nodata: Uint8Array | null): Float32Array {
    const isNodata = (i: number): boolean => (nodata ? nodata[i] === 1 : Number.isNaN(fMin[i]));
    const rgba = new Float32Array(fMin.length * 4);
    for (let i = 0; i < fMin.length; i++) {
        const from = isNodata(i) ? validNeighbour(i, j => !isNodata(j)) : i;
        if (from >= 0) {
            rgba[4 * i] = fMin[from];
            rgba[4 * i + 1] = fMax[from];
        }
        rgba[4 * i + 2] = from === i ? 0 : 1;
    }
    return rgba;
}

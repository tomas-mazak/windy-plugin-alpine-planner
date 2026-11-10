// Temperature at any height for one grid node and step: the model's 2 m temperature moved from the model terrain to
// a real terrain height, with the node's own profile. Kelvin throughout. Pure and framework-free (node:test).

import {
    buildProfile,
    FADE_DEPTH,
    profile,
    STANDARD_LAPSE_RATE,
    surfaceOffset,
    temperatureBelow,
    type ProfileLevel,
} from '../../lib/profile.ts';

// A pressure level over a tile: gh (m) and T (K) per node, NaN = no data.
export type HeightLevel = ProfileLevel<'tempK'>;

// ① below the model terrain, ② inside the profile, ③ above its top.
export type Branch = 1 | 2 | 3;

// T at each of the ascending `heights` (m) for node i, into `out` (K); NaN where z_s or T2m is nodata. Walks the
// heights and the sorted profile together:
// ① T2m + Γ_s · d + min(1, d / 300 m) · Δ at depth d below z_s (the free air, the surface offset Δ fading out),
// ② linear between the profile points, ③ Γ_s above the top.
// Algorithm: docs/forecast-layer-algorithm.md §7.3
export function temperatureAtHeights(
    i: number,
    zs: number,
    t2m: number,
    levels: readonly HeightLevel[],
    heights: Float64Array,
    out: Float32Array,
): void {
    if (Number.isNaN(zs) || Number.isNaN(t2m)) {
        out.fill(NaN, 0, heights.length);
        return;
    }
    const top = buildProfile(i, zs, t2m, levels, 'tempK') - 1;
    const delta = surfaceOffset().delta;
    const { z, t } = profile;
    let k = 1;
    for (let j = 0; j < heights.length; j++) {
        const h = heights[j];
        if (h <= zs) {
            out[j] = temperatureBelow(t2m, delta, zs - h); // ①
        } else if (h > z[top]) {
            out[j] = t[top] - STANDARD_LAPSE_RATE * (h - z[top]); // ③
        } else {
            while (z[k] < h) {
                k++;
            }
            const dz = z[k] - z[k - 1];
            out[j] = dz > 0 ? t[k - 1] + ((t[k] - t[k - 1]) * (h - z[k - 1])) / dz : t[k]; // ②
        }
    }
}

export type HeightSample = {
    t: number; // K, NaN where z_s or T2m is nodata
    branch: Branch;
    l0: { z: number; t: number } | null; // the lowest level above z_s (m, K), null without one
    below: { z: number; t: number } | null; // the highest level at or below z_s, for T_free(z_s); null without one
    tFree: number; // T_free(z_s), K
    delta: number; // the surface offset Δ, K
    d: number; // depth below z_s (m), 0 above it
    w: number; // the fade weight min(1, d / 300 m)
    profile: { z: number; t: number }[]; // (z_s, T2m) and the levels used, by height
};

// T at one height, with the branch, the surface offset and the profile: the picker and the debug readout.
// Algorithm: docs/forecast-layer-algorithm.md §7.3
export function temperatureAt(
    h: number,
    i: number,
    zs: number,
    t2m: number,
    levels: readonly HeightLevel[],
): HeightSample {
    const out = new Float32Array(1);
    temperatureAtHeights(i, zs, t2m, levels, Float64Array.of(h), out);
    const valid = !Number.isNaN(zs) && !Number.isNaN(t2m);
    const n = valid ? buildProfile(i, zs, t2m, levels, 'tempK') : 0;
    const surface = valid ? surfaceOffset() : null;
    const d = Math.max(zs - h, 0);
    return {
        t: out[0],
        branch: h <= zs ? 1 : n > 0 && h > profile.z[n - 1] ? 3 : 2,
        l0: surface?.hasLevel ? { z: surface.l0z, t: surface.l0t } : null,
        below: surface && !Number.isNaN(surface.belowZ) ? { z: surface.belowZ, t: surface.belowT } : null,
        tFree: surface?.tFree ?? NaN,
        delta: surface?.delta ?? NaN,
        d,
        w: Math.min(1, d / FADE_DEPTH),
        profile: Array.from({ length: n }, (_, k) => ({ z: profile.z[k], t: profile.t[k] })),
    };
}

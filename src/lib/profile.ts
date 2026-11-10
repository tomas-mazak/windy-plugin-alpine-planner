// A grid node's vertical temperature profile from the model, shared by the isotherm mask and the forecast layer's
// lapse rate correction, so both compute it identically. Pure and framework-free (node:test).
// Unit-agnostic: temperatures are in whatever unit the caller's level field holds (the isotherm mask: °C, the
// forecast layer: K); the caller names that field, so the unit is explicit at every call site.
// Algorithm: docs/freezing-mask-algorithm.md §4, docs/forecast-layer-algorithm.md §7.3

export const STANDARD_LAPSE_RATE = 0.0065; // K/m (Γ_s): the free air below the model terrain, and above the profile
export const FADE_DEPTH = 300; // m: the surface offset fades out over this depth below the model terrain

// One pressure level over a tile: geopotential height (m) and temperature per node, NaN = no data.
export type ProfileLevel<K extends string> = { gh: Float32Array } & Record<K, Float32Array>;

// The current node's profile, sorted by height: (z_s, T2m) plus the levels above z_s; and the highest level at or below
// z_s (belowZ, belowT; NaN without one), used only for T_free(z_s). Reused, so no per-node allocation; valid until the
// next buildProfile.
export const profile = { z: new Float64Array(16), t: new Float64Array(16), n: 0, belowZ: NaN, belowT: NaN };

// (z_s, T2m) plus every level with gh > z_s and a finite T, insertion-sorted (heights can cross over in bad data).
// A level at or below z_s never enters the profile (the model extrapolates values there); the highest one is kept
// aside for the surface offset. Returns the number of points.
export function buildProfile<K extends string>(
    i: number,
    zs: number,
    t2m: number,
    levels: readonly ProfileLevel<K>[],
    temp: K,
): number {
    profile.z[0] = zs;
    profile.t[0] = t2m;
    profile.belowZ = profile.belowT = NaN;
    let n = 1;
    for (const level of levels) {
        const z = level.gh[i];
        const t = level[temp][i];
        if (Number.isNaN(z) || Number.isNaN(t)) {
            continue;
        }
        if (z <= zs) {
            if (!(z <= profile.belowZ)) {
                profile.belowZ = z; // the highest so far (belowZ starts NaN)
                profile.belowT = t;
            }
            continue;
        }
        let k = n++;
        while (profile.z[k - 1] > z) {
            profile.z[k] = profile.z[k - 1];
            profile.t[k] = profile.t[k - 1];
            k--;
        }
        profile.z[k] = z;
        profile.t[k] = t;
    }
    profile.n = n;
    return n;
}

// The built profile's surface offset (reused object, valid until the next buildProfile): the free air at z_s,
// T_free(z_s), linear between the highest level at or below z_s and the lowest level above it (L0), so it changes
// continuously when a level crosses z_s; without a level below, L0 continued down at the standard lapse rate,
// T_L0 + Γ_s · (gh_L0 − z_s). Δ = T_free(z_s) − T2m. Without a level above z_s, Δ = 0 and T_free(z_s) = T2m.
// belowZ / belowT: the level below used (NaN without one, or without L0).
export const surface = { hasLevel: false, l0z: NaN, l0t: NaN, belowZ: NaN, belowT: NaN, tFree: NaN, delta: 0 };

// Algorithm: docs/forecast-layer-algorithm.md §7.3, docs/freezing-mask-algorithm.md §4
export function surfaceOffset(): typeof surface {
    const { z, t, n, belowZ, belowT } = profile;
    const below = n > 1 && !Number.isNaN(belowZ);
    surface.hasLevel = n > 1;
    surface.l0z = n > 1 ? z[1] : NaN;
    surface.l0t = n > 1 ? t[1] : NaN;
    surface.belowZ = below ? belowZ : NaN;
    surface.belowT = below ? belowT : NaN;
    surface.tFree =
        n === 1
            ? t[0]
            : below
              ? belowT + ((t[1] - belowT) * (z[0] - belowZ)) / (z[1] - belowZ) // z[1] > z_s ≥ belowZ
              : t[1] + STANDARD_LAPSE_RATE * (z[1] - z[0]);
    surface.delta = surface.tFree - t[0];
    return surface;
}

// T at depth d ≥ 0 below the model terrain: T2m + Γ_s · d + min(1, d / FADE_DEPTH) · Δ. The free air deep down,
// the model's surface air at the terrain, the offset fading linearly in between.
// Algorithm: docs/forecast-layer-algorithm.md §7.3, docs/freezing-mask-algorithm.md §4
export const temperatureBelow = (t2m: number, delta: number, d: number): number =>
    t2m + STANDARD_LAPSE_RATE * d + Math.min(1, d / FADE_DEPTH) * delta;

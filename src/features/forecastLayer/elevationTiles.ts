// Our global elevation tiles (~90 m data, zoom 0–10, the terrain masks' source) for the lapse rate correction: each
// tile's height range for the bands, the real height at the picked point, and the heights the colour pass corrects to.
// Same URLs and decoding as the masks, so the browser's HTTP cache is shared.

import { MAX_TILE_ZOOM, tileUrl } from '../elevationMask/constants';
import { mercatorY } from '../../lib/mercator';
import { fetchWindyTile, type WindyTile } from '../../lib/windyTile';

// Decoded tiles, ~66 kB each (the bytes; elevation tiles have no nodata).
const CACHE_SIZE = 128;

export type ElevationTile = { min: number; step: number; grid: Uint8Array };

const cache = new Map<string, { promise: Promise<ElevationTile>; tile: ElevationTile | null }>();

const key = (z: number, x: number, y: number): string => `${z}/${x}/${y}`;

export function loadElevationTile(z: number, x: number, y: number): Promise<ElevationTile> {
    const k = key(z, x, y);
    let entry = cache.get(k);
    if (entry) {
        cache.delete(k);
    } else {
        const promise = fetchWindyTile(tileUrl(z, x, y), 'jpg').then(({ header, grid }: WindyTile) => ({
            ...header,
            grid,
        }));
        const created = { promise, tile: null as ElevationTile | null };
        promise.then(
            tile => (created.tile = tile),
            () => cache.get(k) === created && cache.delete(k),
        );
        entry = created;
    }
    cache.set(k, entry);
    if (cache.size > CACHE_SIZE) {
        cache.delete(cache.keys().next().value!);
    }
    return entry.promise;
}

// A loaded tile, without fetching.
export const cachedElevationTile = (z: number, x: number, y: number): ElevationTile | null =>
    cache.get(key(z, x, y))?.tile ?? null;

// The tile's real terrain range [min, max] (m), from its header.
export const elevationRange = ({ min, step }: ElevationTile): [number, number] => [min, min + 255 * step];

// The real height (m) at a point: the zoom 10 tile, bilinear between its corner-registered nodes.
// Algorithm: docs/forecast-layer-algorithm.md §7.8
export async function elevationAt({ lng, lat }: { lng: number; lat: number }): Promise<number> {
    const n = 2 ** MAX_TILE_ZOOM;
    const mx = ((((lng + 180) / 360) % 1) + 1) % 1;
    const my = Math.min(Math.max(mercatorY(lat), 0), 1 - 1e-9);
    const [x, y] = [Math.floor(mx * n), Math.floor(my * n)];
    const { min, step, grid } = await loadElevationTile(MAX_TILE_ZOOM, x, y);
    const col = (mx * n - x) * 256;
    const row = (my * n - y) * 256;
    const [c0, r0] = [Math.min(Math.floor(col), 255), Math.min(Math.floor(row), 255)];
    const [fc, fr] = [col - c0, row - r0];
    const i = r0 * 257 + c0;
    const b = (1 - fr) * ((1 - fc) * grid[i] + fc * grid[i + 1]) + fr * ((1 - fc) * grid[i + 257] + fc * grid[i + 258]);
    return min + step * b;
}


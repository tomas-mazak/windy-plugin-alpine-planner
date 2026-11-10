// One Min / Max context without the correction: the window's steps of one model run, folded per data tile as
// the step tiles arrive (docs/forecast-layer-algorithm.md §3). It's the layer's data-tile provider, and
// samples the picker's point. The shared source types and tile helpers live here too; correctedSource.ts is the
// corrected source.

import { createFold, foldPoint, type Fold, type FoldKind, type PointSample } from './fold';
import { queueFold } from '../../lib/foldQueue';
import { validNeighbour } from '../../lib/grid';
import { cachedStepTile, loadStepTile, requestStepTile, type StepTile } from '../../lib/stepTiles';
import { dataZoom, pickerDataZoom, stepTileUrl, type TempParams } from './tempTiles';

import type { DataTile, DataTileProvider } from './layer';

export type FoldContext = {
    kind: FoldKind; // Instant + correction: one step, 'max'
    instant: boolean; // Instant + correction: Windy's current step only
    correction: boolean;
    params: TempParams; // Windy's temp render params: model, run, URL template, data quality
    steps: number[]; // ms
    paths: string[]; // each step's URL path segment (calendar.ts2path)
    levels: string[]; // the model's profile levels (correction only)
};

type FoldTile = DataTile & {
    z: number;
    x: number;
    y: number;
    refs: number;
    fold: Fold;
    loaded: number;
    failed: Set<number>; // steps
    cancels: (() => void)[];
};

// Loading progress in steps, over the data tiles: folded (loaded) and failed out of needed; failedSteps: how many of
// the window's steps failed in at least one tile (the status line).
export type FoldStats = {
    tiles: number;
    complete: number;
    loaded: number;
    needed: number;
    failed: number;
    failedSteps: number;
};

// How many distinct steps the tiles' failed sets hold.
export const distinctSteps = (sets: Iterable<Set<number>>): number => new Set([...sets].flatMap(s => [...s])).size;

// The correction's details at a point, for the debug readout.
export type CorrectionInspection = {
    h: number; // real height (m)
    zs: number; // model terrain, bilinear (m)
    t2m: number; // uncorrected T2m at the extreme's step, bilinear (K)
    branch: 1 | 2 | 3; // at the nearest node, at the extreme's step
    l0: { level: string; gh: number; t: number } | null; // the lowest level above z_s (m, K), null without one
    below: { level: string; gh: number; t: number } | null; // the highest level at or below z_s, null without one
    tFree: number; // T_free(z_s), K
    delta: number; // the surface offset Δ, K
    d: number; // depth below z_s (m)
    w: number; // the fade weight min(1, d / 300 m)
    profile: { level: string; gh: number; t: number }[]; // at the nearest node: the fetched levels (K)
    tile: { oLo: number; S: number; K: number; levels: string[]; foldMB: number } | null; // band offsets (m)
};

export type Inspection = PointSample & { correction?: CorrectionInspection };

// A source of the layer's values, one per context (window, model, run, Min/Max, correction).
export type ForecastSource = DataTileProvider & {
    context: FoldContext;
    retire: () => void; // no longer current: stop asking for step tiles, keep what's folded for display
    isComplete: (z: number, x: number, y: number) => boolean;
    stats: () => FoldStats;
    // the picker: waits for missing steps unless aborted; `height` is the real height used (correction only)
    sample: (lngLat: LngLat, zoom: number, signal?: AbortSignal) => Promise<(PointSample & { height?: number }) | null>;
    inspect: (lngLat: LngLat, zoom: number) => Promise<Inspection | null>; // debug: cached steps only
};

export type LngLat = { lng: number; lat: number };

const SIZE = 257 * 257;

// One step's values in K (or m for gh), NaN where nodata: T = min + step · byte.
// Algorithm: docs/forecast-layer-algorithm.md §1.1
export function decode({ header, grid, mask }: StepTile, out = new Float32Array(SIZE)): Float32Array {
    const finite = Number.isFinite(header.min) && Number.isFinite(header.step);
    for (let i = 0; i < SIZE; i++) {
        out[i] = finite && !(mask && mask[i] >= 128) ? header.min + header.step * grid[i] : NaN;
    }
    return out;
}

export const nodeValue = ({ header, grid, mask }: StepTile, i: number): number =>
    Number.isFinite(header.min) && !(mask && mask[i] >= 128) ? header.min + header.step * grid[i] : NaN;

// The data tile and the 2 × 2 nodes around a point, as Windy's interpolator picks them (corner-registered nodes).
export function locate(params: TempParams, { lng, lat }: LngLat, maplibreZoom: number) {
    const z = pickerDataZoom(params, maplibreZoom);
    const n = 2 ** z;
    const mx = ((((lng + 180) / 360) % 1) + 1) % 1;
    const rad = (lat * Math.PI) / 180;
    const my = (1 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / Math.PI) / 2;
    const [x, y] = [Math.floor(mx * n), Math.floor(my * n)];
    const col = (mx * n - x) * 256;
    const row = (my * n - y) * 256;
    const [c0, r0] = [Math.min(Math.floor(col), 255), Math.min(Math.floor(row), 255)];
    const i = r0 * 257 + c0;
    return { z, x, y, inside: y >= 0 && y < n, nodes: [i, i + 1, i + 257, i + 258], fc: col - c0, fr: row - r0 };
}

export type FoldChange = { z: number; x: number; y: number; complete: boolean };

export function createFoldSource(context: FoldContext, onChange: (tile: FoldChange) => void): ForecastSource {
    const { kind, params, steps, paths } = context;
    const tiles = new Map<string, FoldTile>();
    const scratch = new Float32Array(SIZE);
    let retired = false;

    const url = (z: number, x: number, y: number, step: number): string => stepTileUrl(params, paths[step], z, x, y);

    const settle = (tile: FoldTile): void => {
        tile.complete = tile.loaded + tile.failed.size === steps.length;
        if (tile.complete) {
            tile.cancels = [];
        }
        onChange(tile);
    };

    // Algorithm: docs/forecast-layer-algorithm.md §3
    const foldStep = (tile: FoldTile, step: number, stepTile: StepTile): void => {
        tile.fold.add(step, decode(stepTile, scratch), null);
        tile.loaded++;
        tile.version++;
        settle(tile);
    };

    const failStep = (tile: FoldTile, step: number): void => {
        tile.failed.add(step);
        settle(tile);
    };

    function acquire(z: number, x: number, y: number): DataTile {
        const key = `${z}/${x}/${y}`;
        let tile = tiles.get(key);
        if (!tile) {
            const created: FoldTile = {
                version: 0,
                complete: false,
                gpu: null,
                z,
                x,
                y,
                refs: 0,
                fold: createFold(kind),
                loaded: 0,
                failed: new Set(),
                cancels: [],
            };
            tile = created;
            tiles.set(key, created);
            steps.forEach((_, step) => {
                const cached = cachedStepTile(url(z, x, y, step));
                if (cached) {
                    queueFold(step, () => {
                        if (created.refs > 0) {
                            foldStep(created, step, cached);
                        }
                        return true;
                    });
                } else if (!retired) {
                    const onLoad = (t: StepTile): void => foldStep(created, step, t);
                    const onFail = (): void => failStep(created, step);
                    created.cancels.push(requestStepTile(url(z, x, y, step), { z, x, y, step, onLoad, onFail }));
                }
            });
        }
        tile.refs++;
        return tile;
    }

    function release(dataTile: DataTile): boolean {
        const tile = dataTile as FoldTile;
        if (--tile.refs > 0) {
            return false;
        }
        tile.cancels.forEach(cancel => cancel());
        tiles.delete(`${tile.z}/${tile.x}/${tile.y}`);
        return true;
    }

    // Nodata nodes take a valid neighbour's value (or the range minimum): the spline near a domain edge then doesn't
    // see a meaningless value; those areas are drawn grey anyway.
    // Algorithm: docs/forecast-layer-algorithm.md §4
    function pack(dataTile: DataTile): { rg: Float32Array; range: [number, number] } {
        const { value, nodata } = (dataTile as FoldTile).fold;
        const range = (dataTile as FoldTile).fold.range() ?? [0, 0];
        const rg = new Float32Array(SIZE * 2);
        for (let i = 0; i < SIZE; i++) {
            const from = nodata[i] ? validNeighbour(i, j => !nodata[j]) : i;
            rg[2 * i] = from < 0 ? range[0] : value[from];
            rg[2 * i + 1] = nodata[i];
        }
        return { rg, range };
    }

    // The picker at a point: every step's 2 × 2 nodes, from the step tiles, waiting for missing ones; a step that
    // failed is left out.
    // Algorithm: docs/forecast-layer-algorithm.md §5
    async function sample(lngLat: LngLat, maplibreZoom: number, signal?: AbortSignal) {
        const { z, x, y, inside, nodes, fc, fr } = locate(params, lngLat, maplibreZoom);
        if (!inside) {
            return null;
        }
        const stepTiles = await Promise.all(
            steps.map((_, step) => loadStepTile(url(z, x, y, step), { z, x, y, step, urgent: true }, signal)),
        );
        if (signal?.aborted) {
            return null;
        }
        return foldPoint(kind, stepTiles.map(t => t && nodes.map(i => nodeValue(t, i))), fc, fr);
    }

    // The same from the cache only, for the debug readout; missing steps are left out.
    async function inspect(lngLat: LngLat, maplibreZoom: number): Promise<Inspection | null> {
        const { z, x, y, inside, nodes, fc, fr } = locate(params, lngLat, maplibreZoom);
        if (!inside) {
            return null;
        }
        const values = steps.map((_, step) => {
            const t = cachedStepTile(url(z, x, y, step));
            return t ? nodes.map(i => nodeValue(t, i)) : null;
        });
        return foldPoint(kind, values, fc, fr);
    }

    return {
        bands: false,
        context,
        dataZoom: z => dataZoom(params, z),
        acquire,
        release,
        pack,
        retire() {
            retired = true;
            for (const tile of tiles.values()) {
                tile.cancels.forEach(cancel => cancel());
                tile.cancels = [];
            }
        },
        isComplete: (z, x, y) => tiles.get(`${z}/${x}/${y}`)?.complete ?? false,
        stats() {
            const all = [...tiles.values()];
            return {
                tiles: all.length,
                complete: all.filter(t => t.complete).length,
                loaded: all.reduce((sum, t) => sum + t.loaded, 0),
                needed: all.length * steps.length,
                failed: all.reduce((sum, t) => sum + t.failed.size, 0),
                failedSteps: distinctSteps(all.map(t => t.failed)),
            };
        },
        sample,
        inspect,
    };
}

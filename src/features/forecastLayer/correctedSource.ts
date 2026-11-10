// The lapse rate correction (docs/forecast-layer-algorithm.md §7): per data tile, every step's 2 m temperature is
// moved to each node's band heights (relative to its model terrain) with the node's own profile, then folded per band (max / min; Instant + correction
// is one step). It's the layer's band provider, and gives the picker the exact value at the real height.
// Per data tile:
// 1. static, first: the model terrain z_s (loadTerrain, cached per model) and our elevation tile's height range give
//    the bands and the levels to fetch (bands.ts);
// 2. per step: temp-surface plus temp-<L> and gh-<L> for those levels, PNG, through the step-tile scheduler; a step is
//    ready when all its files arrived or failed (a failed level is dropped for that step, a failed T2m fails the step);
// 3. the step is corrected and folded from the fold queue, split by rows (foldQueue.ts).
// Progress is counted in steps: a step counts once it's folded or failed, not when its files arrived.

import { loadTerrain, type TerrainGrid } from '../elevationMask/deg0';
import {
    bandFoldRange,
    bandRange,
    createBandFold,
    foldStepNodes,
    levelsForRange,
    type BandFold,
    type Bands,
    type CorrectedStep,
} from './bands';
import { elevationAt, elevationRange, loadElevationTile, type ElevationTile } from './elevationTiles';
import { foldPoint, type PointSample } from './fold';
import { queueFold } from '../../lib/foldQueue';
import { validNeighbour } from '../../lib/grid';
import {
    decode,
    distinctSteps,
    locate,
    nodeValue,
    type FoldChange,
    type FoldContext,
    type FoldStats,
    type ForecastSource,
    type Inspection,
    type LngLat,
} from './foldSource';
import { temperatureAt, type HeightLevel } from './heightTemperature';
import { cachedStepTile, loadStepTile, requestStepTile, type StepTile } from '../../lib/stepTiles';
import { dataZoom, stepTileUrl } from './tempTiles';

import type { BandData, DataTile } from './layer';

const SIZE = 257 * 257;
const ROWS_PER_CHECK = 8; // a tile-step is folded in chunks of this many rows between deadline checks
const K_OFFSET = 273.15;

// zsFilled: z_s with nodata nodes filled from a valid neighbour (0 without one), for the shader.
type StaticData = { zs: Float32Array; zsFilled: Float32Array; bands: Bands; levels: string[] };

type StepFiles = Map<string, StepTile | null>; // file → tile, null if it failed

type CorrectedTile = DataTile & {
    z: number;
    x: number;
    y: number;
    refs: number;
    static: StaticData | null; // null until the terrain and elevation arrived
    fold: BandFold | null;
    folded: number; // steps
    failed: Set<number>; // steps
    cancels: (() => void)[];
};

// A step's files: T2m, then temperature and height per level.
const stepFiles = (levels: string[]): string[] => ['temp-surface', ...levels.flatMap(l => [`temp-${l}`, `gh-${l}`])];

// The bands and levels of a tile, from its model terrain and our elevation tile at the same z/x/y.
// Algorithm: docs/forecast-layer-algorithm.md §7.5, §7.7
function staticData(terrain: TerrainGrid, elevation: ElevationTile, modelLevels: string[]): StaticData {
    const [eMin, eMax] = elevationRange(elevation);
    let zsMin = Infinity;
    let zsMax = -Infinity;
    for (const z of terrain.values) {
        if (Number.isFinite(z)) {
            zsMin = Math.min(zsMin, z);
            zsMax = Math.max(zsMax, z);
        }
    }
    if (zsMin > zsMax) {
        [zsMin, zsMax] = [eMin, eMin]; // no model terrain here: every node is nodata anyway
    }
    const bands = bandRange(zsMin, zsMax, eMin, eMax);
    const zs = terrain.values;
    const zsFilled = zs.map((z, i) => {
        const from = Number.isNaN(z) ? validNeighbour(i, j => !Number.isNaN(zs[j])) : i;
        return from < 0 ? 0 : zs[from];
    });
    return { zs, zsFilled, bands, levels: levelsForRange(zsMin, bands.hi, modelLevels) };
}

// One step's inputs over a tile (K, m); null without T2m. A level missing its temperature or height is dropped.
// Algorithm: docs/forecast-layer-algorithm.md §7.2
function correctedStep(zs: Float32Array, files: StepFiles, levels: string[]): CorrectedStep | null {
    const t2m = files.get('temp-surface');
    if (!t2m) {
        return null;
    }
    const usable = levels.filter(l => files.get(`temp-${l}`) && files.get(`gh-${l}`));
    return {
        zs,
        t2m: decode(t2m),
        levels: usable.map(l => ({ gh: decode(files.get(`gh-${l}`)!), tempK: decode(files.get(`temp-${l}`)!) })),
    };
}

// The four nodes' values of one field, NaN where missing.
const nodes4 = (tile: StepTile | null | undefined, nodes: number[]): Float32Array =>
    Float32Array.from(nodes, i => (tile ? nodeValue(tile, i) : NaN));

// Reused for packing (grown as needed): the layer uploads them at once.
let packValues = new Float32Array(0);
const packNodata = new Uint8Array(SIZE);

export function createCorrectedSource(context: FoldContext, onChange: (tile: FoldChange) => void): ForecastSource {
    const { kind, params, steps, paths } = context;
    const tiles = new Map<string, CorrectedTile>();
    const logged = new Set<string>();
    let retired = false;

    const url = (z: number, x: number, y: number, step: number, file: string): string =>
        stepTileUrl(params, paths[step], z, x, y, file);

    const settle = (tile: CorrectedTile): void => {
        tile.complete = tile.folded + tile.failed.size === steps.length;
        if (tile.complete) {
            tile.cancels = [];
        }
        onChange(tile);
    };

    // Corrects and folds one ready step, from the fold queue, in row chunks until the slice deadline.
    // Algorithm: docs/forecast-layer-algorithm.md §7.4
    function queueStep(tile: CorrectedTile, step: number, files: StepFiles): void {
        const { zs, levels, bands } = tile.static!;
        let input: CorrectedStep | null = null;
        let node = 0;
        const scratch = new Float32Array(bands.K);
        queueFold(step, deadline => {
            if (tile.refs === 0) {
                return true; // released meanwhile
            }
            input ??= correctedStep(zs, files, levels)!;
            while (node < SIZE) {
                const to = Math.min(node + 257 * ROWS_PER_CHECK, SIZE);
                foldStepNodes(tile.fold!, input, node, to, scratch);
                node = to;
                if (performance.now() >= deadline) {
                    break;
                }
            }
            if (node < SIZE) {
                return false;
            }
            tile.folded++;
            tile.version++;
            settle(tile);
            return true;
        });
    }

    // Requests a step's files; when all arrived or failed, the step is folded (or fails without T2m).
    function requestStep(tile: CorrectedTile, step: number): void {
        const { z, x, y } = tile;
        const files = stepFiles(tile.static!.levels);
        const got: StepFiles = new Map();
        const arrived = (file: string, stepTile: StepTile | null): void => {
            got.set(file, stepTile);
            if (got.size < files.length) {
                return;
            }
            if (got.get('temp-surface')) {
                queueStep(tile, step, got);
            } else {
                tile.failed.add(step);
                settle(tile);
            }
        };
        for (const file of files) {
            const cached = cachedStepTile(url(z, x, y, step, file));
            if (cached) {
                arrived(file, cached);
            } else if (!retired) {
                const onLoad = (t: StepTile): void => arrived(file, t);
                const onFail = (): void => arrived(file, null);
                tile.cancels.push(requestStepTile(url(z, x, y, step, file), { z, x, y, step, onLoad, onFail }));
            }
        }
    }

    async function loadStatic(z: number, x: number, y: number): Promise<StaticData> {
        const terrain = loadTerrain(params.directory, z, x, y);
        const [grid, elevation] = await Promise.all([terrain, loadElevationTile(z, x, y)]);
        return staticData(grid, elevation, context.levels);
    }

    function acquire(z: number, x: number, y: number): DataTile {
        const key = `${z}/${x}/${y}`;
        let tile = tiles.get(key);
        if (!tile) {
            const created: CorrectedTile = {
                version: 0,
                complete: false,
                gpu: null,
                z,
                x,
                y,
                refs: 0,
                static: null,
                fold: null,
                folded: 0,
                failed: new Set(),
                cancels: [],
            };
            tile = created;
            tiles.set(key, created);
            loadStatic(z, x, y).then(
                data => {
                    if (created.refs === 0) {
                        return;
                    }
                    created.static = data;
                    created.fold = createBandFold(kind, data.bands);
                    steps.forEach((_, step) => requestStep(created, step));
                },
                err => {
                    if (!logged.has(key)) {
                        logged.add(key);
                        console.warn(`[alpine-planner] model terrain or elevation failed for ${key}`, err);
                    }
                    steps.forEach((_, step) => created.failed.add(step));
                    settle(created);
                },
            );
        }
        tile.refs++;
        return tile;
    }

    function release(dataTile: DataTile): boolean {
        const tile = dataTile as CorrectedTile;
        if (--tile.refs > 0) {
            return false;
        }
        tile.cancels.forEach(cancel => cancel());
        tiles.delete(`${tile.z}/${tile.x}/${tile.y}`);
        return true;
    }

    // °C (half floats keep ≤ 0.03 K there), band-major, and each node's model terrain z_s (m). Nodata nodes take a
    // valid neighbour's values first, as without the correction (no neighbour: the range minimum; drawn grey anyway).
    // Algorithm: docs/forecast-layer-algorithm.md §7.6
    function packBands(dataTile: DataTile): BandData {
        const tile = dataTile as CorrectedTile;
        const { value, nodata, bands } = tile.fold!;
        const { K, oLo, S } = bands;
        const range = bandFoldRange(tile.fold!) ?? [K_OFFSET, K_OFFSET];
        if (packValues.length < K * SIZE) {
            packValues = new Float32Array(K * SIZE);
        }
        const values = packValues.subarray(0, K * SIZE);
        for (let i = 0; i < SIZE; i++) {
            const from = nodata[i] ? validNeighbour(i, j => !nodata[j]) : i;
            for (let k = 0; k < K; k++) {
                values[k * SIZE + i] = from < 0 ? range[0] - K_OFFSET : value[k * SIZE + from] - K_OFFSET;
            }
            packNodata[i] = nodata[i] ? 255 : 0;
        }
        const celsius: [number, number] = [range[0] - K_OFFSET, range[1] - K_OFFSET];
        return { values, nodata: packNodata, zs: tile.static!.zsFilled, oLo, S, K, range: celsius };
    }

    // Every step's corrected values at the four nodes around a point, at the real height h: per step [4] K, or null
    // if the step's T2m is missing. `files` gives a step's files (null when missing).
    // Algorithm: docs/forecast-layer-algorithm.md §7.8
    function pointSeries(
        h: number,
        nodes: number[],
        data: StaticData,
        stepsFiles: (StepFiles | null)[],
    ): (number[] | null)[] {
        return stepsFiles.map(files => {
            const t2m = files?.get('temp-surface');
            if (!files || !t2m) {
                return null;
            }
            const usable = data.levels.filter(l => files.get(`temp-${l}`) && files.get(`gh-${l}`));
            const levels: HeightLevel[] = usable.map(l => ({
                gh: nodes4(files.get(`gh-${l}`), nodes),
                tempK: nodes4(files.get(`temp-${l}`), nodes),
            }));
            const t2m4 = nodes4(t2m, nodes);
            return nodes.map((node, k) => temperatureAt(h, k, data.zs[node], t2m4[k], levels).t);
        });
    }

    // A step's files for the picker (waiting, urgent) or the debug readout (cached only).
    const loadFiles = async (z: number, x: number, y: number, step: number, levels: string[], signal?: AbortSignal) => {
        const files = stepFiles(levels);
        const tiles = await Promise.all(
            files.map(file => loadStepTile(url(z, x, y, step, file), { z, x, y, step, urgent: true }, signal)),
        );
        return new Map(files.map((file, i) => [file, tiles[i]]));
    };

    const cachedFiles = (z: number, x: number, y: number, step: number, levels: string[]): StepFiles =>
        new Map(stepFiles(levels).map(file => [file, cachedStepTile(url(z, x, y, step, file)) ?? null]));

    async function sample(lngLat: LngLat, zoom: number, signal?: AbortSignal) {
        const { z, x, y, inside, nodes, fc, fr } = locate(params, lngLat, zoom);
        if (!inside) {
            return null;
        }
        try {
            const [h, data] = await Promise.all([elevationAt(lngLat), loadStatic(z, x, y)]);
            const stepsFiles = await Promise.all(steps.map((_, step) => loadFiles(z, x, y, step, data.levels, signal)));
            if (signal?.aborted) {
                return null;
            }
            const point = foldPoint(kind, pointSeries(h, nodes, data, stepsFiles), fc, fr);
            return point && { ...point, height: h };
        } catch {
            return null;
        }
    }

    async function inspect(lngLat: LngLat, zoom: number): Promise<Inspection | null> {
        const { z, x, y, inside, nodes, fc, fr } = locate(params, lngLat, zoom);
        if (!inside) {
            return null;
        }
        const loaded = Promise.all([elevationAt(lngLat), loadStatic(z, x, y)]);
        const [h, data] = await loaded.catch(() => [NaN, null] as const);
        if (!data) {
            return null;
        }
        const stepsFiles = steps.map((_, step) => cachedFiles(z, x, y, step, data.levels));
        const point: PointSample | null = foldPoint(kind, pointSeries(h, nodes, data, stepsFiles), fc, fr);
        if (!point) {
            return null;
        }
        const files = stepsFiles[point.stepIndex];
        const w = [(1 - fc) * (1 - fr), fc * (1 - fr), (1 - fc) * fr, fc * fr];
        const bilinear = (v: ArrayLike<number>): number => w.reduce((sum, wk, k) => sum + wk * v[k], 0);
        const nearest = w.indexOf(Math.max(...w));
        const levels = data.levels.filter(l => files.get(`temp-${l}`) && files.get(`gh-${l}`));
        const gh = levels.map(l => nodes4(files.get(`gh-${l}`), [nodes[nearest]])[0]);
        const temp = levels.map(l => nodes4(files.get(`temp-${l}`), [nodes[nearest]])[0]);
        const t2m4 = nodes4(files.get('temp-surface'), nodes);
        const at = temperatureAt(
            h,
            0,
            data.zs[nodes[nearest]],
            t2m4[nearest],
            levels.map((_, j) => ({ gh: Float32Array.of(gh[j]), tempK: Float32Array.of(temp[j]) })),
        );
        const tile = tiles.get(`${z}/${x}/${y}`);
        return {
            ...point,
            correction: {
                h,
                zs: bilinear(nodes.map(i => data.zs[i])),
                t2m: bilinear(t2m4),
                branch: at.branch,
                l0: at.l0 ? { level: levels[gh.indexOf(at.l0.z)] ?? '?', gh: at.l0.z, t: at.l0.t } : null,
                below: at.below ? { level: levels[gh.indexOf(at.below.z)] ?? '?', gh: at.below.z, t: at.below.t } : null,
                tFree: at.tFree,
                delta: at.delta,
                d: at.d,
                w: at.w,
                profile: levels.map((level, j) => ({ level, gh: gh[j], t: temp[j] })),
                tile: tile?.static
                    ? {
                          oLo: tile.static.bands.oLo,
                          S: tile.static.bands.S,
                          K: tile.static.bands.K,
                          levels: tile.static.levels,
                          foldMB: tile.fold ? (tile.fold.value.byteLength + tile.fold.nodata.byteLength) / 1e6 : 0,
                      }
                    : null,
            },
        };
    }

    return {
        bands: true,
        context,
        dataZoom: z => dataZoom(params, z),
        acquire,
        release,
        packBands,
        retire() {
            retired = true;
            for (const tile of tiles.values()) {
                tile.cancels.forEach(cancel => cancel());
                tile.cancels = [];
            }
        },
        isComplete: (z, x, y) => tiles.get(`${z}/${x}/${y}`)?.complete ?? false,
        stats(): FoldStats {
            const all = [...tiles.values()];
            return {
                tiles: all.length,
                complete: all.filter(t => t.complete).length,
                loaded: all.reduce((sum, t) => sum + t.folded, 0),
                needed: all.length * steps.length,
                failed: all.reduce((sum, t) => sum + t.failed.size, 0),
                failedSteps: distinctSteps(all.map(t => t.failed)),
            };
        },
        sample,
        inspect,
    };
}

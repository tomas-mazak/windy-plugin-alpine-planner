// The isotherm mask over a time window (Min / Max / Both). Per deg0 data tile (the same data zoom and tiles as
// Instant), every window step's F is computed exactly as Instant's (deg0, the model terrain and, with the lapse rate
// correction, T2m and the pressure levels) and folded into its minimum and maximum (isoFold.ts):
// - the step files go through the request scheduler and step cache shared with the forecast layer
//   (src/lib/stepTiles.ts), with the same priority (view centre, then step order);
// - each step's F is computed from the shared time-sliced fold queue (src/lib/foldQueue.ts), in row chunks;
// - a tile is loaded (drawn) from its first folded step and refines as the others arrive: its texture is re-uploaded
//   at most every UPLOAD_INTERVAL_MS while it loads, and once when complete.
// A step whose deg0 fails (after the scheduler's retry) is left out and counted; a failed T2m makes that step use the
// "off" result (counted with the failed steps in the status, apart in debug), and a failed level is dropped for that
// step, as for Instant. One cache per window context (steps,
// model, run, premium status, correction); Min, Max and Both share it.
// Algorithm: docs/freezing-mask-algorithm.md §6.3

import { queueFold } from '../../lib/foldQueue';
import { cachedStepTile, requestStepTile, type StepTile } from '../../lib/stepTiles';
import { windyTileValues } from '../../lib/windyTile';
import { forecastUrl, loadTerrain, type Deg0WindowContext, type TerrainGrid } from './deg0';
import { effectiveFreezingLevel, freezingNode, type CorrectionData } from './freezingLevel';
import { createIsoFold, type IsoFold } from './isoFold';
import { createCache, createFTexture, type CacheOpts, type Coords } from './tiles';

const SIZE = 257 * 257;
const ROWS_PER_CHECK = 16; // a tile-step's F is computed in chunks of this many rows between deadline checks
const UPLOAD_INTERVAL_MS = 300;
const K_OFFSET = 273.15;

export type WindowTile = {
    kind: 'window';
    coords: Coords;
    tex: WebGLTexture | null; // RGBA16F: R = F_min, G = F_max, B = nodata
    allNodata: boolean;
    terrain: TerrainGrid | null; // once it arrived
    fold: IsoFold;
    loaded: number; // steps folded
    failed: Set<number>; // steps left out (deg0 failed)
    fellBack: Set<number>; // steps folded without the correction (T2m failed)
    complete: boolean;
    cancels: (() => void)[];
    dead: boolean; // evicted or aborted
    uploadTimer: ReturnType<typeof setTimeout> | null;
    uploadedAt: number;
};

export type WindowStats = {
    tiles: number;
    complete: number;
    loaded: number; // steps folded, over the tiles
    needed: number;
    failed: number; // steps left out, over the tiles
    failedSteps: number; // the window's steps left out or uncorrected in at least one tile (the status line)
    fellBack: number; // of those, the window's steps folded without the correction in at least one tile
    lastUploadAt: number | null; // performance.now()
};

export type WindowTileCache = {
    cache: L.TileCache<WindowTile>;
    stats: () => WindowStats;
    // debug: F of every step at a node of a loaded tile, from the cached step files (NaN where not cached)
    inspect: (tile: WindowTile, node: number) => number[];
};

type StepFiles = Map<string, StepTile | null>; // file → tile, null if it failed

// A step's files: deg0, plus with the correction T2m and temperature and height per level.
const stepFiles = (correction: boolean, levels: string[]): string[] =>
    correction ? ['deg0-surface', 'temp-surface', ...levels.flatMap(l => [`temp-${l}`, `gh-${l}`])] : ['deg0-surface'];

type Decode = (tile: StepTile, offset?: number) => Float32Array;

// A whole tile's values (offset: K → °C).
const decodeTile: Decode = (tile, offset = 0) => {
    const v = windyTileValues(tile);
    return offset ? v.map(k => k + offset) : v;
};

// One node's value, as a one-node array (the debug readout).
const decodeNode =
    (i: number): Decode =>
    ({ header, grid, mask }, offset = 0) =>
        Float32Array.of(
            Number.isFinite(header.min) && Number.isFinite(header.step) && !(mask && mask[i] >= 128)
                ? header.min + header.step * grid[i] + offset
                : NaN,
        );

// One step's inputs to effectiveFreezingLevel; deg0 must be there. Without T2m the step uses the "off" result; a level
// missing its temperature or height is dropped.
// Algorithm: docs/freezing-mask-algorithm.md §2, §4
function stepInput(files: StepFiles, levels: string[], decode: Decode) {
    const deg0 = files.get('deg0-surface')!;
    const t2m = files.get('temp-surface');
    const correction: CorrectionData | false = t2m
        ? {
              t2mC: decode(t2m, -K_OFFSET),
              levels: levels
                  .filter(l => files.get(`temp-${l}`) && files.get(`gh-${l}`))
                  .map(l => ({ tempC: decode(files.get(`temp-${l}`)!, -K_OFFSET), gh: decode(files.get(`gh-${l}`)!) })),
          }
        : false;
    return { deg0: decode(deg0), deg0Step: deg0.header.step, correction };
}

export function createWindowTileCache(
    opts: CacheOpts & { ctx: Deg0WindowContext; correction: boolean; onCorrectionFailed: () => void },
): WindowTileCache {
    const { gl, ctx, correction, onCorrectionFailed, onTileSettled } = opts;
    const { model, paths } = ctx;
    const { steps } = ctx.selection;
    const files = stepFiles(correction, model.levels);
    const tiles = new Set<WindowTile>();
    let lastUploadAt: number | null = null;

    const url = ({ z, x, y }: Coords, step: number, file: string): string => forecastUrl(model, paths[step], file, z, x, y);

    const drop = (tile: WindowTile): void => {
        tile.dead = true;
        tile.cancels.forEach(cancel => cancel());
        tile.cancels = [];
        if (tile.uploadTimer) {
            clearTimeout(tile.uploadTimer);
        }
        tiles.delete(tile);
    };

    // Computes one step's F from the fold queue, in row chunks until the slice deadline, and folds it.
    function queueStep(tile: WindowTile, step: number, got: StepFiles, terrain: TerrainGrid, onFolded: () => void): void {
        let input: ReturnType<typeof stepInput> | null = null;
        let F: Float32Array | null = null;
        let node = 0;
        queueFold(step, deadline => {
            if (tile.dead) {
                return true;
            }
            input ??= stepInput(got, model.levels, decodeTile);
            F ??= new Float32Array(SIZE);
            const freezingSteps = { deg0: input.deg0Step, terrain: terrain.step };
            while (node < SIZE) {
                const to = Math.min(node + 257 * ROWS_PER_CHECK, SIZE);
                effectiveFreezingLevel(input.deg0, terrain.values, freezingSteps, input.correction, F, node, to);
                node = to;
                if (performance.now() >= deadline) {
                    break;
                }
            }
            if (node < SIZE) {
                return false;
            }
            tile.fold.add(F);
            tile.loaded++;
            onFolded();
            return true;
        });
    }

    // Resolves once the tile has data (its first upload); rejects when aborted, when the terrain fails or when every
    // step failed.
    const load = (coords: Coords, abort: AbortSignal): Promise<WindowTile> =>
        new Promise((resolve, reject) => {
            const tile: WindowTile = {
                kind: 'window',
                coords,
                tex: null,
                allNodata: true,
                terrain: null,
                fold: createIsoFold(),
                loaded: 0,
                failed: new Set(),
                fellBack: new Set(),
                complete: false,
                cancels: [],
                dead: false,
                uploadTimer: null,
                uploadedAt: -Infinity,
            };
            tiles.add(tile);
            const fail = (err: unknown): void => {
                drop(tile);
                reject(err);
            };
            abort.addEventListener('abort', () => fail(new DOMException('aborted', 'AbortError')));
            const terrain = loadTerrain(model.directory, coords.z, coords.x, coords.y);
            terrain.then(grid => (tile.terrain = grid), fail);

            const upload = (): void => {
                tile.uploadTimer = null;
                if (tile.dead) {
                    return;
                }
                if (tile.tex) {
                    gl.deleteTexture(tile.tex);
                    tile.tex = null;
                }
                const { min, max, nodata } = tile.fold;
                tile.allNodata = nodata.every(Boolean);
                if (!tile.allNodata) {
                    tile.tex = createFTexture(gl, min, max, nodata);
                }
                tile.uploadedAt = lastUploadAt = performance.now();
                resolve(tile); // the first upload makes the tile drawable
                onTileSettled(); // repaint
            };

            const settle = (): void => {
                tile.complete = tile.loaded + tile.failed.size === steps.length;
                if (tile.fold.count === 0) {
                    if (tile.complete) {
                        fail(new Error(`every step failed for deg0 tile ${coords.z}/${coords.x}/${coords.y}`));
                    }
                } else if (tile.complete) {
                    if (tile.uploadTimer) {
                        clearTimeout(tile.uploadTimer);
                    }
                    upload();
                } else {
                    const wait = Math.max(0, tile.uploadedAt + UPLOAD_INTERVAL_MS - performance.now());
                    tile.uploadTimer ??= setTimeout(upload, wait);
                }
            };

            steps.forEach((_, step) => {
                const got: StepFiles = new Map();
                const arrived = (file: string, stepTile: StepTile | null): void => {
                    got.set(file, stepTile);
                    if (!stepTile && file !== 'deg0-surface') {
                        onCorrectionFailed();
                    }
                    if (got.size < files.length || tile.dead) {
                        return;
                    }
                    if (!got.get('deg0-surface')) {
                        tile.failed.add(step);
                        settle();
                        return;
                    }
                    if (correction && !got.get('temp-surface')) {
                        tile.fellBack.add(step);
                    }
                    terrain.then(
                        grid => queueStep(tile, step, got, grid, settle),
                        () => {}, // the tile failed
                    );
                };
                for (const file of files) {
                    const u = url(coords, step, file);
                    const cached = cachedStepTile(u);
                    if (cached) {
                        arrived(file, cached);
                    } else {
                        const onLoad = (t: StepTile): void => arrived(file, t);
                        const onFail = (): void => arrived(file, null);
                        tile.cancels.push(requestStepTile(u, { ...coords, step, onLoad, onFail }));
                    }
                }
            });
        });

    const cache = createCache('deg0 window', opts, load, drop);

    return {
        cache,
        stats() {
            const all = [...tiles];
            return {
                tiles: all.length,
                complete: all.filter(t => t.complete).length,
                loaded: all.reduce((sum, t) => sum + t.loaded, 0),
                needed: all.length * steps.length,
                failed: all.reduce((sum, t) => sum + t.failed.size, 0),
                failedSteps: new Set(all.flatMap(t => [...t.failed, ...t.fellBack])).size,
                fellBack: new Set(all.flatMap(t => [...t.fellBack])).size,
                lastUploadAt,
            };
        },
        inspect(tile, node) {
            const terrain = tile.terrain;
            return steps.map((_, step) => {
                const got: StepFiles = new Map(files.map(file => [file, cachedStepTile(url(tile.coords, step, file)) ?? null]));
                if (!terrain || !got.get('deg0-surface')) {
                    return NaN;
                }
                const input = stepInput(got, model.levels, decodeNode(node));
                const freezingSteps = { deg0: input.deg0Step, terrain: terrain.step };
                return freezingNode(0, input.deg0, Float32Array.of(terrain.values[node]), freezingSteps, input.correction).F;
            });
        },
    };
}

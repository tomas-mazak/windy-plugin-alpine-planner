// L.TileCache wiring (classic API, see docs/windy-integration.md):
// `new L.TileCache(loadTile, beforeTileDeleted)`, `cache.update({min,max}, tileZ)`,
// `cache.getOrderedTilePyramid(bounds, tileZ, maxLower, maxHigher)`. The
// transform-based `update(transform, {...})` signature and `gatherForRendering`
// don't work for plugins -- don't use them.

import { fetchWindyTile, windyTileValues, type WindyTileHeader } from '../../lib/windyTile';
import { tileUrl } from './constants';
import { forecastUrl, loadTerrain, type Deg0ContextOk } from './deg0';
import { effectiveFreezingLevel, fTexels, type FreezingSteps } from './freezingLevel';

export type Tile = {
    tex: WebGLTexture;
    header: WindyTileHeader;
    grid: Uint8Array;
};

// One pressure level of the lapse rate profile.
export type ProfileLevel = { level: string; tempC: Float32Array; gh: Float32Array };

// A freezing-mask tile of Instant: the model fields (NaN = no data) and the effective freezing level F computed from
// them, uploaded as the F texture (createFTexture, R = G = F). A tile with no data at all gets `allNodata` and no
// texture.
export type Deg0Tile = {
    kind: 'instant';
    coords: Coords;
    tex: WebGLTexture | null;
    deg0: Float32Array; // m
    terrain: Float32Array; // model terrain, m
    steps: FreezingSteps;
    // The lapse rate correction's data: undefined = not loaded, null = T2m failed (the tile uses the "off" result).
    correction: { t2mC: Float32Array; levels: ProfileLevel[] } | null | undefined;
    correctionAbort: AbortController | null; // while the correction data loads after the tile
    F: Float32Array;
    allNodata: boolean;
};

export type Deg0TileCache = {
    cache: L.TileCache<Deg0Tile>;
    tiles: Set<Deg0Tile>;
    // Recomputes F for every tile; turning it on first loads each tile's missing correction data, and that tile keeps
    // its "off" F until its data arrives. Returns the recompute time in ms.
    setCorrection: (on: boolean) => number;
    correctionPending: () => number;
};

export type TileIndexBounds = { min: { x: number; y: number }; max: { x: number; y: number } };

export type Coords = { x: number; y: number; z: number };

export type CacheOpts = {
    gl: WebGL2RenderingContext;
    onTileFailed: () => void;
    onTileSettled: () => void;
};

// The cache passes canonical coordinates here; wrapping is a safety net.
const wrapX = (x: number, z: number): number => ((x % 2 ** z) + 2 ** z) % 2 ** z;

export function isAbortError(err: unknown): boolean {
    return err instanceof DOMException && err.name === 'AbortError';
}

export function createTexture(
    gl: WebGL2RenderingContext,
    internalFormat: number,
    format: number,
    type: number,
    pixels: ArrayBufferView,
): WebGLTexture {
    const tex = gl.createTexture();
    if (!tex) {
        throw new Error('gl.createTexture failed');
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); // R8 rows are 257 bytes, not a multiple of 4
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 257, 257, 0, format, type, pixels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
}

// The F texture of a deg0 tile: RGBA16F, R = F_min, G = F_max (m), B = nodata (1), nodata nodes filled from a
// neighbour (fTexels). Instant: R = G = F. A null nodata mask means nodata where fMin is NaN.
// Algorithm: docs/freezing-mask-algorithm.md §5, §6.3
export function createFTexture(
    gl: WebGL2RenderingContext,
    fMin: Float32Array,
    fMax: Float32Array,
    nodata: Uint8Array | null,
): WebGLTexture {
    return createTexture(gl, gl.RGBA16F, gl.RGBA, gl.FLOAT, fTexels(fMin, fMax, nodata));
}

export function createCache<T extends { tex: WebGLTexture | null }>(
    name: string,
    { gl, onTileFailed, onTileSettled }: CacheOpts,
    load: (coords: Coords, abort: AbortSignal) => Promise<T>,
    onDeleted?: (tile: T) => void,
): L.TileCache<T> {
    const loadTile = async (coords: Coords, abort: AbortSignal): Promise<T | null> => {
        try {
            return await load({ ...coords, x: wrapX(coords.x, coords.z) }, abort);
        } catch (err) {
            if (isAbortError(err)) {
                // Per the TileCache contract, an aborted load must throw an
                // object whose `message` contains "aborted".
                throw { message: 'aborted' };
            }
            console.warn(`[alpine-planner] ${name} tile ${coords.z}/${coords.x}/${coords.y} failed to load`, err);
            onTileFailed();
            return null;
        } finally {
            onTileSettled();
        }
    };

    const beforeTileDeleted = (_coords: Coords, data: T | null): void => {
        if (data?.tex) {
            gl.deleteTexture(data.tex);
        }
        if (data) {
            onDeleted?.(data);
        }
    };

    return new L.TileCache<T>(loadTile, beforeTileDeleted);
}

// The global elevation layer has no nodata, so only the R channel is used.
export function createTileCache(opts: CacheOpts): L.TileCache<Tile> {
    const { gl } = opts;
    return createCache('elevation', opts, async ({ x, y, z }, abort) => {
        const { header, grid } = await fetchWindyTile(tileUrl(z, x, y), 'jpg', abort);
        return { tex: createTexture(gl, gl.R8, gl.RED, gl.UNSIGNED_BYTE, grid), header, grid };
    });
}

// Algorithm: docs/freezing-mask-algorithm.md §5
// (Re)computes F and its texture, e.g. when the lapse rate correction is toggled. Never call it from render().
function updateDeg0Texture(gl: WebGL2RenderingContext, tile: Deg0Tile, correction: boolean): void {
    tile.F = effectiveFreezingLevel(tile.deg0, tile.terrain, tile.steps, (correction && tile.correction) || false);
    tile.allNodata = tile.F.every(Number.isNaN);
    if (tile.tex) {
        gl.deleteTexture(tile.tex);
        tile.tex = null;
    }
    if (!tile.allNodata) {
        tile.tex = createFTexture(gl, tile.F, tile.F, null);
    }
}

// One cache entry loads deg0 of the context's step and the model terrain in parallel, plus with the correction on its
// T2m and pressure levels; it's loaded when all are. A failure of deg0 or terrain fails the tile; a failure of T2m
// makes the tile use the "off" result, and a failed level is dropped for that tile. Those are counted with
// onCorrectionFailed and logged once per field per context.
export function createDeg0TileCache(
    opts: CacheOpts & { ctx: Deg0ContextOk; correction: boolean; onCorrectionFailed: () => void },
): Deg0TileCache {
    const { gl, ctx, onCorrectionFailed, onTileSettled } = opts;
    let correctionOn = opts.correction;
    const tiles = new Set<Deg0Tile>();
    const logged = new Set<string>();

    // A field's values: temperatures K → °C (offset), heights in m. Algorithm: docs/freezing-mask-algorithm.md §2
    const values = async (file: string, { x, y, z }: Coords, abort: AbortSignal, offset = 0): Promise<Float32Array> => {
        const v = windyTileValues(await fetchWindyTile(forecastUrl(ctx.model, ctx.path, file, z, x, y), 'png', abort));
        return offset ? v.map(k => k + offset) : v;
    };

    // Resolves to null for a failed field; rejects only when aborted.
    const optional = <T>(file: string, p: Promise<T>): Promise<T | null> =>
        p.catch(err => {
            if (isAbortError(err)) {
                throw err;
            }
            onCorrectionFailed();
            if (!logged.has(file)) {
                logged.add(file);
                console.warn(`[alpine-planner] ${file} failed to load (logged once per context)`, err);
            }
            return null;
        });

    const loadCorrection = async (coords: Coords, abort: AbortSignal): Promise<Deg0Tile['correction']> => {
        const [t2mC, ...levels] = await Promise.all([
            optional('temp-surface', values('temp-surface', coords, abort, -273.15)),
            ...ctx.model.levels.map(level =>
                optional(
                    level,
                    Promise.all([values(`temp-${level}`, coords, abort, -273.15), values(`gh-${level}`, coords, abort)]).then(
                        ([tempC, gh]) => ({ level, tempC, gh }),
                    ),
                ),
            ),
        ]);
        return t2mC ? { t2mC, levels: levels.filter(l => l !== null) } : null;
    };

    // Loads a cached tile's missing correction data, then recomputes it on its own.
    const completeCorrection = (tile: Deg0Tile): void => {
        const abort = new AbortController();
        tile.correctionAbort = abort;
        loadCorrection(tile.coords, abort.signal).then(
            correction => {
                tile.correctionAbort = null;
                tile.correction = correction;
                if (tiles.has(tile)) {
                    updateDeg0Texture(gl, tile, correctionOn);
                    onTileSettled(); // repaint
                }
            },
            () => {
                tile.correctionAbort = null; // aborted: the tile was evicted
            },
        );
    };

    const load = async (coords: Coords, abort: AbortSignal): Promise<Deg0Tile> => {
        const { x, y, z } = coords;
        const [deg0, terrain, correction] = await Promise.all([
            fetchWindyTile(forecastUrl(ctx.model, ctx.path, 'deg0-surface', z, x, y), 'png', abort),
            loadTerrain(ctx.model.directory, z, x, y),
            correctionOn ? loadCorrection(coords, abort) : undefined,
        ]);
        const tile: Deg0Tile = {
            kind: 'instant',
            coords,
            tex: null,
            deg0: windyTileValues(deg0),
            terrain: terrain.values,
            steps: { deg0: deg0.header.step, terrain: terrain.step },
            correction,
            correctionAbort: null,
            F: new Float32Array(0),
            allNodata: true,
        };
        updateDeg0Texture(gl, tile, correctionOn);
        tiles.add(tile);
        if (correctionOn && correction === undefined) {
            completeCorrection(tile); // turned on while this tile loaded
        }
        return tile;
    };

    const cache = createCache('deg0', opts, load, tile => {
        tile.correctionAbort?.abort();
        tiles.delete(tile);
    });

    return {
        cache,
        tiles,
        setCorrection(on: boolean): number {
            correctionOn = on;
            const start = performance.now();
            for (const tile of tiles) {
                if (on && tile.correction === undefined) {
                    if (!tile.correctionAbort) {
                        completeCorrection(tile); // keeps its "off" F until the data arrives
                    }
                } else {
                    updateDeg0Texture(gl, tile, on);
                }
            }
            return performance.now() - start;
        },
        correctionPending: () => [...tiles].filter(t => t.correctionAbort).length,
    };
}

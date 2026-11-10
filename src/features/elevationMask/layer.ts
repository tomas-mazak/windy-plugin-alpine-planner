// The real elevation-mask CustomLayerInterface. Tile management is
// L.TileCache's classic API (tiles.ts); geometry is one quad per drawn tile
// in Mercator pixel space (docs/windy-integration.md); overlapping
// ancestor/descendant tiles from the pyramid are resolved with the stencil
// test, as Windy's own raster layers do (most detailed tile wins).

import { grayMapZoomEnd } from '@windy/baseMap';
import { isGlobeActive, map as windyMap } from '@windy/map';

import { mercatorX, mercatorY } from '../../lib/mercator';
import {
    BOTH_BAND_OPACITY,
    BOTH_LINE_WIDTH_PX,
    DEG0_PREVIOUS_MAX_MS,
    LAYER_BUCKET,
    LAYER_BUCKET_HIGH_ZOOM,
    MASK_OPACITY,
    MAX_ELEVATION,
    MAX_LOWER_ZOOM_ALLOWED,
    MAX_TILE_ZOOM,
    MIN_TILE_ZOOM,
    WINDOW_RETIRE_DELAY_MS,
} from './constants';
import { getAref, type Deg0Context, type Deg0WindowContext } from './deg0';
import { FADE_DEPTH } from '../../lib/profile';
import { freezingNode, type Branch } from './freezingLevel';
import { FRAGMENT_SHADER, VERTEX_SHADER } from './shaders';
import {
    createDeg0TileCache,
    createTileCache,
    type Deg0Tile,
    type Deg0TileCache,
    type Tile,
    type TileIndexBounds,
} from './tiles';
import { createWindowTileCache, type WindowStats, type WindowTile, type WindowTileCache } from './windowTiles';

export type MaskMode = 'elevation' | 'freezing';

// The isotherm over Windy's timeline time, or over the mask's own window (docs/freezing-mask-algorithm.md §6).
export type IsoMode = 'instant' | 'min' | 'max' | 'both';

export type DebugCounts = {
    tileZ: number | null;
    mapZoom: number | null;
    cached: number;
    pending: number;
    failed: number;
    renders: number;
    bucket: number | null;
    deg0Key: string | null;
    deg0Z: number | null;
    deg0Cached: number;
    deg0Pending: number;
    deg0Failed: number;
    deg0Previous: boolean;
    aref: string | null;
    correctionPending: number; // tiles still loading their correction data after the correction was turned on
    correctionFailed: number; // T2m or level fields that failed
    recomputeMs: number | null; // the last toggle's F recompute, all cached tiles
    window: WindowStats | null; // Min / Max / Both: the current window's fold progress
};

// At the cursor in freezing mode, without the offset: the nearest grid node's inputs and branch, and F at the cursor
// (bilinear, as drawn).
export type Deg0Sample =
    | { nodata: true }
    | {
          nodata: false;
          deg0: number;
          terrain: number;
          correction: 'off' | 'loading' | 'T2m failed' | 'on';
          t2mC: number | null;
          profile: { level: string; gh: number; tempC: number; ignored: boolean }[];
          // the correction's branches (fade, free air): the lowest level above the terrain and the highest at or below
          // it (null without one), T_free at the terrain (°C), the surface offset (K), the crossing depth below the
          // terrain (m); NaN otherwise
          l0: { level: string; gh: number; tempC: number } | null;
          below: { level: string; gh: number; tempC: number } | null;
          tFree: number;
          delta: number;
          d0: number;
          d: number; // the cursor's depth below the model terrain (m, 0 above it)
          w: number; // the surface offset's fade weight there, min(1, d / 300 m)
          branch: Branch;
          F: number; // at the node
          Fpx: number; // at the cursor
      };

// At the cursor in Min / Max / Both, without the offset: every step's F at the nearest grid node (NaN where its files
// aren't cached), and the folded F_min / F_max at the cursor (bilinear, as drawn).
export type WindowSample =
    | { nodata: true }
    | { nodata: false; steps: number[]; F: number[]; FminPx: number; FmaxPx: number };

export type CursorSample = {
    tileZ: number;
    x: number;
    y: number;
    row: number;
    col: number;
    v: number;
    h: number;
    deg0: Deg0Sample | null;
    window: WindowSample | null;
};

export type ElevationMaskLayer = L.CustomLayerInterface & {
    setRange: (from: number, to: number) => void;
    setMode: (mode: MaskMode) => void;
    setOffset: (metres: number) => void;
    setDeg0Context: (ctx: Deg0Context) => void;
    setIsoMode: (mode: IsoMode) => void;
    setWindowContext: (ctx: Deg0WindowContext | null) => void;
    setLapseCorrection: (on: boolean) => void;
    setDebugOptions: (opts: { raw: boolean; borders: boolean }) => void;
    getDebugCounts: () => DebugCounts;
    isHiddenForGlobe: () => boolean;
    sampleAt: (lngLat: { lng: number; lat: number }) => CursorSample | null;
};

// Same rule as Windy's wind particles: from MapLibre zoom
// grayMapZoomEnd - 0.5 the opaque topo map covers bucket 350.
export function bucketForZoom(maplibreZoom: number): number {
    return maplibreZoom < grayMapZoomEnd - 0.5 ? LAYER_BUCKET : LAYER_BUCKET_HIGH_ZOOM;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(Math.max(v, lo), hi);
}

function bilinearSample(grid: ArrayLike<number>, col: number, row: number): number {
    const c = clamp(col, 0, 256);
    const r = clamp(row, 0, 256);
    const c0 = Math.floor(c);
    const r0 = Math.floor(r);
    const c1 = Math.min(c0 + 1, 256);
    const r1 = Math.min(r0 + 1, 256);
    const fc = c - c0;
    const fr = r - r0;
    const top = grid[r0 * 257 + c0] * (1 - fc) + grid[r0 * 257 + c1] * fc;
    const bottom = grid[r1 * 257 + c0] * (1 - fc) + grid[r1 * 257 + c1] * fc;
    return top * (1 - fr) + bottom * fr;
}

type MaskTile = Deg0Tile | WindowTile;

// One context's deg0 tiles: Instant's step, or a window's fold.
type Deg0Cache = {
    key: string;
    maxZoom: number;
    cache: L.TileCache<MaskTile>;
    instant: Deg0TileCache | null;
    window: (WindowTileCache & { ctx: Deg0WindowContext }) | null;
};

// A window cache is loaded once its tiles have data (their first step).
const isFullyLoaded = (c: Deg0Cache): boolean => c.cache.requestedTilesCount > 0 && c.cache.pendingTilesCount === 0;

// Maps an elevation tile's local [0,1]^2 into the deg0 tile (zd) containing it: offset x/y, scale.
function deg0Rect(x: number, y: number, z: number, zd: number): [number, number, number] {
    const n = 2 ** (z - zd);
    const mod = (v: number) => ((v % n) + n) % n; // x may be unwrapped (negative)
    return [mod(x) / n, mod(y) / n, 1 / n];
}

export function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
    const shader = gl.createShader(type);
    if (!shader) {
        throw new Error('gl.createShader failed');
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`shader compile error: ${log ?? '(no log)'}`);
    }
    return shader;
}

// x is NOT clamped: across the antimeridian MapLibre's getBounds() returns unwrapped longitudes, so x may be
// negative or >= n. L.TileCache copes with that (checked in leaflet-gl-src.js): update() loads the wrapped, deduplicated
// tiles, getOrderedTilePyramid() accepts unwrapped bounds and returns tiles with unwrapped x (one per world copy), and
// getData() accepts them too. So x stays unwrapped for drawing and only loadTile wraps it. At most one world is requested.
function viewTileZ(map: L.MapLibreMap): number {
    return clamp(Math.floor(map.getZoom() + 1), MIN_TILE_ZOOM, MAX_TILE_ZOOM);
}

export function viewTileBounds(map: L.MapLibreMap, tileZ: number): TileIndexBounds {
    const n = 2 ** tileZ;
    const b = map.getBounds();
    let xMin = Math.floor(mercatorX(b.getWest()) * n);
    let xMax = Math.floor(mercatorX(b.getEast()) * n);
    if (xMax - xMin >= n) {
        xMin = Math.floor((xMin + xMax) / 2) - Math.floor(n / 2); // low zoom: several world copies, keep one around the centre
        xMax = xMin + n - 1;
    }
    return {
        min: { x: xMin, y: clamp(Math.floor(mercatorY(b.getNorth()) * n), 0, n - 1) },
        max: { x: xMax, y: clamp(Math.floor(mercatorY(b.getSouth()) * n), 0, n - 1) },
    };
}

export function createElevationMaskLayer(opts: {
    id: string;
    initialFrom: number;
    initialTo: number;
}): ElevationMaskLayer {
    const { id } = opts;

    let map: L.MapLibreMap | null = null;
    let gl: WebGL2RenderingContext | null = null;
    let program: WebGLProgram | null = null;
    let quadBuffer: WebGLBuffer | null = null;
    let aLocal = -1;
    let uMatrix: WebGLUniformLocation | null = null;
    let uQuadBounds: WebGLUniformLocation | null = null;
    let uMin: WebGLUniformLocation | null = null;
    let uStep: WebGLUniformLocation | null = null;
    let uFrom: WebGLUniformLocation | null = null;
    let uTo: WebGLUniformLocation | null = null;
    let uOpacity: WebGLUniformLocation | null = null;
    let uDebugRaw: WebGLUniformLocation | null = null;
    let uDebugBorders: WebGLUniformLocation | null = null;
    let uTileSampler: WebGLUniformLocation | null = null;
    let uMode: WebGLUniformLocation | null = null;
    let uFSampler: WebGLUniformLocation | null = null;
    let uD0Rect: WebGLUniformLocation | null = null;
    let uAllNodata: WebGLUniformLocation | null = null;
    let uOffset: WebGLUniformLocation | null = null;
    let uIso: WebGLUniformLocation | null = null;
    let uBandOpacity: WebGLUniformLocation | null = null;
    let uLineWidth: WebGLUniformLocation | null = null;

    let cache: L.TileCache<Tile> | null = null;
    let from = opts.initialFrom;
    let to = opts.initialTo;
    let debugRaw = false;
    let debugBorders = false;
    let hiddenForGlobe = false;
    let failedCount = 0;
    let renderCount = 0;
    let currentBucket: number | null = null;
    let lastTileZ: number | null = null;
    let lastMapZoom: number | null = null;
    let lastPyramid: Array<{ x: number; y: number; z: number }> = [];

    let mode: MaskMode = 'elevation';
    let offset = 0;
    let isoMode: IsoMode = 'instant';
    let deg0Ctx: Deg0Context | null = null; // Instant
    let windowCtx: Deg0WindowContext | null = null; // Min / Max / Both
    let deg0: Deg0Cache | null = null; // the current context's tiles
    let deg0Previous: Deg0Cache | null = null; // drawn where the current context's tiles aren't loaded yet
    let deg0PreviousSince = 0;
    let deg0Failed = 0;
    let lapseCorrection = false;
    let correctionFailed = 0;
    let recomputeMs: number | null = null;
    let lastDeg0Z: number | null = null;
    const retiring = new Set<{ timer: ReturnType<typeof setTimeout>; cache: L.TileCache<MaskTile> }>();

    // Freezing mode loads the deg0 tiles for the view at min(tileZ, the model's max zoom).
    function updateDeg0Cache(): void {
        if (!map || !deg0 || mode !== 'freezing') {
            return;
        }
        const zd = Math.min(viewTileZ(map), deg0.maxZoom);
        deg0.cache.update(viewTileBounds(map, zd) as unknown as L.Bounds, zd);
        lastDeg0Z = zd;
    }

    function onMapMove(): void {
        if (!map || !cache) {
            return;
        }
        const tileZ = viewTileZ(map);
        cache.update(viewTileBounds(map, tileZ) as unknown as L.Bounds, tileZ);
        updateDeg0Cache();
    }

    // The tiles to draw: Instant's step (the correction is applied in place), or the window's fold (min, max and both
    // share it; the correction makes a new fold). null: nothing to draw, the panel shows why.
    function wantedKey(): string | null {
        if (isoMode === 'instant') {
            return deg0Ctx?.ok ? deg0Ctx.key : null;
        }
        return windowCtx ? `${windowCtx.key}/${lapseCorrection ? 'corrected' : 'off'}` : null;
    }

    // A replaced window cache is disposed a little later, so the new one has registered the step tiles they share.
    function dispose(c: Deg0Cache): void {
        if (!c.window) {
            c.cache.dispose();
            return;
        }
        const entry = {
            timer: setTimeout(() => {
                retiring.delete(entry);
                c.cache.dispose();
            }, WINDOW_RETIRE_DELAY_MS),
            cache: c.cache,
        };
        retiring.add(entry);
    }

    function createDeg0Cache(gl: WebGL2RenderingContext, key: string): Deg0Cache {
        const opts = {
            gl,
            correction: lapseCorrection,
            onCorrectionFailed: () => correctionFailed++,
            onTileFailed: () => deg0Failed++,
            onTileSettled: () => map?.triggerRepaint(),
        };
        if (isoMode !== 'instant' && windowCtx) {
            const window = { ...createWindowTileCache({ ...opts, ctx: windowCtx }), ctx: windowCtx };
            return { key, maxZoom: windowCtx.model.maxZoom, cache: window.cache, instant: null, window };
        }
        const ctx = deg0Ctx as Extract<Deg0Context, { ok: true }>;
        const instant = createDeg0TileCache({ ...opts, ctx });
        return { key, maxZoom: ctx.model.maxZoom, cache: instant.cache, instant, window: null };
    }

    // A new context gets a new cache. The better loaded of the current and previous caches stays as the fallback
    // (fast timeline scrubbing creates several caches before any is complete); the other is disposed. Never called
    // from render(), so no disposed texture is bound in the current frame.
    function syncDeg0Cache(): void {
        const key = wantedKey();
        if (!gl || key === null || key === deg0?.key) {
            return;
        }
        if (deg0 && deg0Previous && !isFullyLoaded(deg0)) {
            dispose(deg0);
        } else {
            if (deg0Previous) {
                dispose(deg0Previous);
            }
            deg0Previous = deg0;
        }
        deg0 = createDeg0Cache(gl, key);
        deg0PreviousSince = Date.now();
        updateDeg0Cache();
    }

    // The deg0 tile covering an elevation tile: the current context first, then the previous one; the deg0 zoom is
    // min(z, maxZoom), or coarser if only an ancestor is loaded. x stays unwrapped (getData accepts it).
    function findDeg0(x: number, y: number, z: number): { tile: MaskTile; zd: number; c: Deg0Cache } | null {
        for (const c of [deg0, deg0Previous]) {
            if (!c) {
                continue;
            }
            for (let zd = Math.min(z, c.maxZoom); zd >= 0; zd--) {
                const tile = c.cache.getData({ x: x >> (z - zd), y: y >> (z - zd), z: zd });
                if (tile) {
                    return { tile, zd, c };
                }
            }
        }
        return null;
    }

    function onZoom(): void {
        if (!map) {
            return;
        }
        const desiredBucket = bucketForZoom(map.getZoom());
        if (desiredBucket !== currentBucket) {
            windyMap.moveMapLibreOrderedLayerToBucket(id, desiredBucket);
            currentBucket = desiredBucket;
        }
    }

    return {
        id,
        type: 'custom',
        renderingMode: '2d',

        onAdd(mapInstance: L.MapLibreMap, glContext: WebGLRenderingContext | WebGL2RenderingContext) {
            map = mapInstance;
            if (!(glContext instanceof WebGL2RenderingContext)) {
                console.warn('[alpine-planner] elevation mask requires WebGL2, which is not available here');
                return;
            }
            gl = glContext;

            program = gl.createProgram();
            if (!program) {
                throw new Error('gl.createProgram failed');
            }
            gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
            gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                throw new Error(`program link error: ${gl.getProgramInfoLog(program) ?? '(no log)'}`);
            }

            aLocal = gl.getAttribLocation(program, 'aLocal');
            uMatrix = gl.getUniformLocation(program, 'u_matrix');
            uQuadBounds = gl.getUniformLocation(program, 'u_quadBounds');
            uMin = gl.getUniformLocation(program, 'u_min');
            uStep = gl.getUniformLocation(program, 'u_step');
            uFrom = gl.getUniformLocation(program, 'u_from');
            uTo = gl.getUniformLocation(program, 'u_to');
            uOpacity = gl.getUniformLocation(program, 'u_opacity');
            uDebugRaw = gl.getUniformLocation(program, 'u_debugRaw');
            uDebugBorders = gl.getUniformLocation(program, 'u_debugBorders');
            uTileSampler = gl.getUniformLocation(program, 'u_tile');
            uMode = gl.getUniformLocation(program, 'u_mode');
            uFSampler = gl.getUniformLocation(program, 'u_F');
            uD0Rect = gl.getUniformLocation(program, 'u_d0rect');
            uAllNodata = gl.getUniformLocation(program, 'u_allNodata');
            uOffset = gl.getUniformLocation(program, 'u_offset');
            uIso = gl.getUniformLocation(program, 'u_iso');
            uBandOpacity = gl.getUniformLocation(program, 'u_bandOpacity');
            uLineWidth = gl.getUniformLocation(program, 'u_lineWidth');

            quadBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

            cache = createTileCache({
                gl,
                onTileFailed: () => failedCount++,
                onTileSettled: () => map?.triggerRepaint(),
            });
            syncDeg0Cache();

            currentBucket = bucketForZoom(map.getZoom());
            map.on('zoom', onZoom);
            map.on('move', onMapMove);
            void map.once('render', onMapMove);
        },

        onRemove() {
            // Remove first: unhook
            // listeners and free GL resources before anything else reads state.
            if (map) {
                map.off('zoom', onZoom);
                map.off('move', onMapMove);
            }
            cache?.dispose(); // calls beforeTileDeleted for every cached tile -> deletes textures
            cache = null;
            retiring.forEach(({ timer, cache: retired }) => {
                clearTimeout(timer);
                retired.dispose();
            });
            retiring.clear();
            deg0?.cache.dispose();
            deg0Previous?.cache.dispose();
            deg0 = null;
            deg0Previous = null;
            if (gl) {
                if (program) {
                    gl.deleteProgram(program);
                }
                if (quadBuffer) {
                    gl.deleteBuffer(quadBuffer);
                }
            }
            map = null;
            gl = null;
            program = null;
            lastPyramid = [];
        },

        render(glContext: WebGLRenderingContext | WebGL2RenderingContext, args: L.CustomRenderMethodInput) {
            if (!map || !gl || !program || !cache) {
                return;
            }
            renderCount++;

            let globeActive = false;
            try {
                globeActive = isGlobeActive();
            } catch {
                globeActive = false;
            }
            hiddenForGlobe = globeActive;
            if (globeActive) {
                return;
            }

            const freezing = mode === 'freezing';
            if (freezing && (wantedKey() === null || !deg0)) {
                return; // no usable freezing level: the panel shows the reason
            }
            // Before anything is bound: drop the previous context's tiles once the current ones cover the view.
            if (deg0 && deg0Previous && (isFullyLoaded(deg0) || Date.now() - deg0PreviousSince > DEG0_PREVIOUS_MAX_MS)) {
                deg0Previous.cache.dispose();
                deg0Previous = null;
            }

            const zoom = map.getZoom();
            const worldSize = 512 * 2 ** zoom;
            const tileZ = viewTileZ(map);
            lastTileZ = tileZ;
            lastMapZoom = zoom;

            let pyramid: Array<{ x: number; y: number; z: number }> = [];
            try {
                pyramid = cache.getOrderedTilePyramid(
                    viewTileBounds(map, tileZ) as unknown as L.Bounds,
                    tileZ,
                    MAX_LOWER_ZOOM_ALLOWED,
                    0,
                );
            } catch (err) {
                console.warn('[alpine-planner] getOrderedTilePyramid failed', err);
            }
            lastPyramid = pyramid;

            gl.useProgram(program);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.CULL_FACE);

            // Tiles from the pyramid can overlap (an ancestor plus some loaded
            // children); the stencil test picks the most detailed one per pixel
            // (as Windy's own raster layers do).
            gl.enable(gl.STENCIL_TEST);
            gl.stencilMask(0xff);
            gl.clearStencil(0);
            gl.clear(gl.STENCIL_BUFFER_BIT);
            gl.stencilFunc(gl.NOTEQUAL, 1, 0xff);
            gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);

            gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
            gl.enableVertexAttribArray(aLocal);
            gl.vertexAttribPointer(aLocal, 2, gl.FLOAT, false, 0, 0);
            gl.activeTexture(gl.TEXTURE0);
            gl.uniform1i(uTileSampler, 0);
            gl.uniformMatrix4fv(uMatrix, false, args.modelViewProjectionMatrix as unknown as Float32Array);
            gl.uniform1f(uFrom, from);
            // The top slider position means "no upper limit".
            gl.uniform1f(uTo, to >= MAX_ELEVATION ? 1e6 : to);
            gl.uniform1f(uOpacity, MASK_OPACITY);
            gl.uniform1i(uDebugRaw, debugRaw ? 1 : 0);
            gl.uniform1i(uDebugBorders, debugBorders ? 1 : 0);
            gl.uniform1i(uMode, freezing ? 1 : 0);
            gl.uniform1i(uFSampler, 1);
            gl.uniform1f(uOffset, offset);
            gl.uniform1i(uIso, isoMode === 'min' ? 1 : isoMode === 'both' ? 2 : 0);
            gl.uniform1f(uBandOpacity, BOTH_BAND_OPACITY);
            gl.uniform1f(uLineWidth, BOTH_LINE_WIDTH_PX);

            const drawQuad = (x: number, y: number, z: number, data: Tile): void => {
                if (!gl) {
                    return;
                }
                const n = 2 ** z;
                gl.uniform4f(uQuadBounds, (x / n) * worldSize, (y / n) * worldSize, ((x + 1) / n) * worldSize, ((y + 1) / n) * worldSize);
                gl.uniform1f(uMin, data.header.min);
                gl.uniform1f(uStep, data.header.step);
                gl.bindTexture(gl.TEXTURE_2D, data.tex);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            };

            const bindDeg0 = (x: number, y: number, z: number, { tile, zd }: { tile: MaskTile; zd: number }): void => {
                if (!gl) {
                    return;
                }
                gl.uniform3f(uD0Rect, ...deg0Rect(x, y, z, zd));
                gl.uniform1i(uAllNodata, tile.allNodata ? 1 : 0);
                if (tile.tex) {
                    gl.activeTexture(gl.TEXTURE1);
                    gl.bindTexture(gl.TEXTURE_2D, tile.tex);
                    gl.activeTexture(gl.TEXTURE0);
                }
            };

            // Data tiles, highest zoom first so the most detailed tile wins the
            // stencil claim on any overlapping pixel. An ancestor tile is drawn
            // at its own extent, not the child's -- no sub-rectangle math needed.
            for (let i = pyramid.length - 1; i >= 0; i--) {
                const coords = pyramid[i];
                const data = cache.getData(coords);
                if (!data) {
                    continue;
                }
                if (freezing) {
                    // No deg0 tile loaded yet: skip, rather than flash fully dimmed.
                    const found = findDeg0(coords.x, coords.y, coords.z);
                    if (!found) {
                        continue;
                    }
                    bindDeg0(coords.x, coords.y, coords.z, found);
                }
                drawQuad(coords.x, coords.y, coords.z, data);
            }

            if (freezing) {
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, null);
                gl.activeTexture(gl.TEXTURE0);
            }
            gl.disable(gl.STENCIL_TEST);
            gl.disable(gl.BLEND);

            // We used the stencil test this frame; reset it after drawing, as Windy's
            // raster layers do, so MapLibre knows to redraw its own stencil masks.
            (map as unknown as { painter?: { clearStencil?: () => void } }).painter?.clearStencil?.();
        },

        setRange(newFrom: number, newTo: number) {
            from = newFrom;
            to = newTo;
            map?.triggerRepaint();
        },

        setMode(newMode: MaskMode) {
            mode = newMode;
            updateDeg0Cache();
            map?.triggerRepaint();
        },

        setOffset(metres: number) {
            offset = metres;
            map?.triggerRepaint();
        },

        setDeg0Context(ctx: Deg0Context) {
            deg0Ctx = ctx;
            syncDeg0Cache();
            map?.triggerRepaint();
        },

        // Switching between Min, Max and Both only changes the shader; from or to Instant changes the tiles.
        setIsoMode(mode: IsoMode) {
            isoMode = mode;
            syncDeg0Cache();
            map?.triggerRepaint();
        },

        setWindowContext(ctx: Deg0WindowContext | null) {
            windowCtx = ctx;
            syncDeg0Cache();
            map?.triggerRepaint();
        },

        // Instant: recomputes F for every cached Instant tile, current and previous context; turning it on loads each
        // tile's missing correction data first, turning it off needs no network. Min / Max / Both: a new fold.
        setLapseCorrection(on: boolean) {
            if (on === lapseCorrection) {
                return;
            }
            lapseCorrection = on;
            recomputeMs = (deg0?.instant?.setCorrection(on) ?? 0) + (deg0Previous?.instant?.setCorrection(on) ?? 0);
            syncDeg0Cache();
            map?.triggerRepaint();
        },

        setDebugOptions({ raw, borders }: { raw: boolean; borders: boolean }) {
            debugRaw = raw;
            debugBorders = borders;
            map?.triggerRepaint();
        },

        getDebugCounts(): DebugCounts {
            return {
                tileZ: lastTileZ,
                mapZoom: lastMapZoom,
                cached: cache?.cachedTilesCount ?? 0,
                pending: cache?.pendingTilesCount ?? 0,
                failed: failedCount,
                renders: renderCount,
                bucket: currentBucket,
                deg0Key: deg0?.key ?? null,
                deg0Z: lastDeg0Z,
                deg0Cached: deg0?.cache.cachedTilesCount ?? 0,
                deg0Pending: deg0?.cache.pendingTilesCount ?? 0,
                deg0Failed,
                deg0Previous: deg0Previous !== null,
                aref: (deg0Ctx?.ok && getAref(deg0Ctx.model.directory)) || (windowCtx && getAref(windowCtx.model.directory)) || null,
                correctionPending: deg0?.instant?.correctionPending() ?? 0,
                correctionFailed,
                recomputeMs,
                window: deg0?.window?.stats() ?? null,
            };
        },

        isHiddenForGlobe() {
            return hiddenForGlobe;
        },

        sampleAt(lngLat: { lng: number; lat: number }): CursorSample | null {
            if (!cache || lastPyramid.length === 0) {
                return null;
            }
            const mx = mercatorX(lngLat.lng);
            const my = mercatorY(lngLat.lat);
            // Highest zoom first, matching render's stencil priority, so the
            // readout always matches what's visually on top.
            for (let i = lastPyramid.length - 1; i >= 0; i--) {
                const c = lastPyramid[i];
                const n = 2 ** c.z;
                const x0 = c.x / n;
                const x1 = (c.x + 1) / n;
                const y0 = c.y / n;
                const y1 = (c.y + 1) / n;
                // the pyramid's x is unwrapped: shift the cursor into this tile's world copy
                const mxShifted = mx + Math.floor(x0);
                if (mxShifted < x0 || mxShifted >= x1 || my < y0 || my >= y1) {
                    continue;
                }
                const data = cache.getData(c);
                if (!data) {
                    continue;
                }
                const col = ((mxShifted - x0) / (x1 - x0)) * 256;
                const row = ((my - y0) / (y1 - y0)) * 256;
                const v = bilinearSample(data.grid, col, row);
                const h = data.header.min + data.header.step * v;
                const found = mode === 'freezing' ? findDeg0(c.x, c.y, c.z) : null;
                let deg0Sample: CursorSample['deg0'] = null;
                let windowSample: CursorSample['window'] = null;
                const [ox, oy, scale] = found ? deg0Rect(c.x, c.y, c.z, found.zd) : [0, 0, 1];
                const dCol = (ox + (col / 256) * scale) * 256;
                const dRow = (oy + (row / 256) * scale) * 256;
                const node = Math.round(clamp(dRow, 0, 256)) * 257 + Math.round(clamp(dCol, 0, 256));
                if (found?.tile.kind === 'window' && found.c.window) {
                    const { tile } = found;
                    const FminPx = bilinearSample(tile.fold.min, dCol, dRow);
                    const FmaxPx = bilinearSample(tile.fold.max, dCol, dRow);
                    windowSample =
                        tile.fold.nodata[node] || !Number.isFinite(FminPx) || !Number.isFinite(FmaxPx)
                            ? { nodata: true }
                            : {
                                  nodata: false,
                                  steps: found.c.window.ctx.selection.steps,
                                  F: found.c.window.inspect(tile, node),
                                  FminPx,
                                  FmaxPx,
                              };
                } else if (found?.tile.kind === 'instant') {
                    const { tile } = found;
                    const corr = (lapseCorrection && tile.correction) || false;
                    const r = freezingNode(node, tile.deg0, tile.terrain, tile.steps, corr);
                    const Fpx = tile.allNodata ? NaN : bilinearSample(tile.F, dCol, dRow); // NaN near nodata
                    if (Number.isNaN(r.F) || Number.isNaN(Fpx)) {
                        deg0Sample = { nodata: true };
                    } else {
                        const terrain = tile.terrain[node];
                        deg0Sample = {
                            nodata: false,
                            deg0: tile.deg0[node],
                            terrain,
                            correction: !lapseCorrection
                                ? 'off'
                                : tile.correction === undefined
                                  ? 'loading'
                                  : tile.correction === null
                                    ? 'T2m failed'
                                    : 'on',
                            t2mC: corr ? corr.t2mC[node] : null,
                            profile: corr
                                ? corr.levels.map(({ level, gh, tempC }) => ({
                                      level,
                                      gh: gh[node],
                                      tempC: tempC[node],
                                      ignored: !(gh[node] > terrain) || Number.isNaN(tempC[node]),
                                  }))
                                : [],
                            l0:
                                corr && !r.noLevel && !Number.isNaN(r.l0z)
                                    ? {
                                          level: corr.levels.find(l => l.gh[node] === r.l0z)?.level ?? '?',
                                          gh: r.l0z,
                                          tempC: r.l0t,
                                      }
                                    : null,
                            below:
                                corr && !Number.isNaN(r.belowZ)
                                    ? {
                                          level: corr.levels.find(l => l.gh[node] === r.belowZ)?.level ?? '?',
                                          gh: r.belowZ,
                                          tempC: r.belowT,
                                      }
                                    : null,
                            tFree: r.tFree,
                            delta: r.delta,
                            d0: r.d0,
                            d: Math.max(terrain - h, 0),
                            w: Math.min(1, Math.max(terrain - h, 0) / FADE_DEPTH),
                            branch: r.branch,
                            F: r.F,
                            Fpx,
                        };
                    }
                }
                return {
                    tileZ: c.z,
                    x: c.x,
                    y: c.y,
                    row: Math.round(clamp(row, 0, 256)),
                    col: Math.round(clamp(col, 0, 256)),
                    v: Math.round(v),
                    h,
                    deg0: deg0Sample,
                    window: windowSample,
                };
            }
            return null;
        },
    };
}

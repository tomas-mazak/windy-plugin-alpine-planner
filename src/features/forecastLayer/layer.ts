// Our temperature layer: drawn exactly as Windy draws its own (verified by alternating it with Windy's layer), from the
// values of a data-tile provider (the min/max folds, or the corrected band folds). It mirrors the two passes of Windy's
// temperature layer (docs/windy-integration.md):
// 1. colour (prerender): each render tile (256 px, z = round(MapLibre zoom + 1), as Windy's TileCache picks it) is
//    coloured into a 256² RGBA8 texture at texel centres, from its data tile's texture (shaders.ts);
// 2. draw (render): each render tile's texture is drawn with LINEAR filtering, opaque, from the most detailed loaded
//    tile, then the framebuffer's alpha is set to 1, as Windy does.
// A data tile's values go into one RG32F texture, re-uploaded at most every UPLOAD_INTERVAL_MS while it loads and once
// when complete; its render tiles are then coloured again. The layer sits in Windy's bucket (layerOrder.MAIN), so it
// blends with the base map exactly like Windy's layer: the grey map draws over it, and from MapLibre zoom 10.5 the
// opaque topo map covers it. Not drawn in the 3D globe.
// Algorithm: docs/forecast-layer-algorithm.md §4

import { isGlobeActive } from '@windy/map';

import { mercatorY } from '../../lib/mercator';
import { MAX_TILE_ZOOM } from '../elevationMask/constants';
import { compileShader, viewTileBounds } from '../elevationMask/layer';
import { tempColorLut } from './colorLut';
import { cachedElevationTile, loadElevationTile, type ElevationTile } from './elevationTiles';
import { COLOR_BANDS_FS, COLOR_FS, COLOR_VS, DRAW_FS, DRAW_VS } from './shaders';

const TEXTURE_SIZE = 256;
const MAX_RENDER_ZOOM = 20; // Windy's zoom2zoom tables end at 20
const MAX_LOWER_ZOOM = 4; // a loading tile shows a coarser loaded ancestor meanwhile
const PREVIOUS_MAX_MS = 10 * 1000; // after a provider change, the previous tiles fill in while the new ones load
const UPLOAD_INTERVAL_MS = 300;
const ELEVATION_TEXTURES = 64; // uploaded elevation tiles kept (~66 kB each)

type Coords = { x: number; y: number; z: number };
type Rect = [number, number, number]; // x and y offset, size: a render tile's part of a coarser tile, in [0, 1]
type Elevation = { tex: WebGLTexture; tile: ElevationTile; zE: number; rect: Rect };

// A data tile (257² nodes) from a provider. Its values change while it loads (version goes up); the layer owns `gpu`.
export type DataTile = {
    version: number; // 0: no data yet
    complete: boolean; // no more changes are coming
    gpu: {
        tex: WebGLTexture; // flat: RG32F 257² (K, nodata); bands: R16F 257² × K array (°C)
        nodataTex: WebGLTexture | null; // bands: R8 257², 255 = nodata
        zsTex: WebGLTexture | null; // bands: R32F 257², the model terrain (m)
        zs: Float32Array | null; // bands: the same on the CPU (the debug clamp count)
        bands: { oLo: number; S: number; K: number } | null;
        version: number;
        uploadedAt: number;
        range: [number, number]; // flat: K; bands: °C
    } | null;
};

// One value per node: RG32F texels (r: K, every node filled; g: 1 = nodata) and the valid values' [min, max] (K).
export type FlatData = { rg: Float32Array; range: [number, number] };

// Values at K height bands (lapse rate correction, docs/forecast-layer-algorithm.md §7.5): °C, band-major
// (values[k · 257² + i]), every node filled; the nodata mask (255 = nodata); each node's model terrain z_s (m, filled);
// the band offsets from z_s, oLo + k · S; [min, max] in °C. zs is the tile's own (it doesn't change between uploads).
export type BandData = {
    values: Float32Array;
    nodata: Uint8Array;
    zs: Float32Array;
    oLo: number;
    S: number;
    K: number;
    range: [number, number];
};

// Where the layer's values come from: the min/max folds (foldSource.ts, flat) or the corrected folds
// (correctedSource.ts, bands).
export type DataTileProvider = {
    dataZoom: (z: number) => number; // the data tile zoom for a render tile zoom
    acquire: (z: number, x: number, y: number) => DataTile;
    release: (tile: DataTile) => boolean; // true: its last user released it, so the layer frees its textures
} & ({ bands: false; pack: (tile: DataTile) => FlatData } | { bands: true; packBands: (tile: DataTile) => BandData });

type RenderTile = {
    data: DataTile;
    rect: [number, number, number]; // the render tile in its data tile: size and x/y offset, in data pixels
    tex: WebGLTexture | null; // coloured texture, null until the colour pass
    // what it was last coloured from; elevZ: the elevation tile's zoom (bands only)
    colored: { version: number; lutVersion: number; elevZ: number | null } | null;
    clamps: { outside: number; nodes: number } | null; // bands: elevation nodes outside the bands (taking the end band)
};

type TileSet = { provider: DataTileProvider; cache: L.TileCache<RenderTile> };

export type LayerCounts = {
    tileZ: number | null;
    dataZ: number | null;
    renderTiles: number;
    previous: boolean;
    uploads: number;
    lastUploadMs: number | null; // pack + upload of the last data tile
    lastUploadAt: number | null; // performance.now()
    colored: number;
    renders: number;
    dataMB: number; // data tile textures on the GPU (flat RG32F; bands R16F array + R8 mask + R32F z_s)
    elevationTextures: number;
};

export type ForecastMapLayer = L.CustomLayerInterface & {
    setProvider: (provider: DataTileProvider) => void;
    repaint: () => void; // a data tile changed
    refreshColors: () => void; // Windy's palette changed
    getDebugCounts: () => LayerCounts;
    // bands: the elevation nodes outside the band range, over the render tiles of the data tile under a point
    bandClampsAt: (lngLat: { lng: number; lat: number }) => { outside: number; nodes: number } | null;
};

const viewTileZ = (map: L.MapLibreMap): number => Math.min(Math.max(Math.round(map.getZoom() + 1), 0), MAX_RENDER_ZOOM);

const wrapX = (x: number, z: number): number => ((x % 2 ** z) + 2 ** z) % 2 ** z;

function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
    const program = gl.createProgram();
    if (!program) {
        throw new Error('gl.createProgram failed');
    }
    gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`program link error: ${gl.getProgramInfoLog(program) ?? '(no log)'}`);
    }
    return program;
}

function createTexture(
    gl: WebGL2RenderingContext,
    [internalFormat, format, type]: [number, number, number],
    width: number,
    height: number,
    pixels: ArrayBufferView | null,
    filter: number,
): WebGLTexture {
    const tex = gl.createTexture();
    if (!tex) {
        throw new Error('gl.createTexture failed');
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, pixels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
}

export function createForecastMapLayer(id: string): ForecastMapLayer {
    let map: L.MapLibreMap | null = null;
    let gl: WebGL2RenderingContext | null = null;
    let colorProgram: WebGLProgram | null = null;
    let bandProgram: WebGLProgram | null = null;
    const elevationTextures = new Map<string, { tex: WebGLTexture; tile: ElevationTile }>(); // LRU
    const elevationRequested = new Set<string>();
    let drawProgram: WebGLProgram | null = null;
    let quadBuffer: WebGLBuffer | null = null;
    let fbo: WebGLFramebuffer | null = null;
    let lutTex: WebGLTexture | null = null;
    let lut = tempColorLut();
    let lutVersion = 0;
    let lutUploaded = -1;
    let maxLayers: number | null = null; // MAX_ARRAY_TEXTURE_LAYERS (≥ 256), read once
    let layersWarned = false;

    let pendingProvider: DataTileProvider | null = null; // set before onAdd
    let current: TileSet | null = null;
    let previous: TileSet | null = null;
    let previousSince = 0;
    let currentCovered = false; // the current set has drawn the whole view at least once
    let repaintTimer: ReturnType<typeof setTimeout> | null = null;
    let lastTileZ: number | null = null;
    const counts = { uploads: 0, lastUploadMs: null as number | null, lastUploadAt: null as number | null, colored: 0 };
    let renders = 0;
    // Computed in prerender, drawn in render: current tiles first, so they win the stencil.
    let toDraw: Array<{ set: TileSet; pyramid: Coords[] }> = [];

    const loc = (program: WebGLProgram, name: string) => gl!.getUniformLocation(program, name);

    function createTileSet(provider: DataTileProvider): TileSet {
        const load = async (coords: Coords): Promise<RenderTile> => {
            const x = wrapX(coords.x, coords.z);
            const dz = provider.dataZoom(coords.z);
            const scale = 2 ** (coords.z - dz); // render tiles per data tile, per axis
            const data = provider.acquire(dz, Math.floor(x / scale), Math.floor(coords.y / scale));
            const size = TEXTURE_SIZE / scale;
            const rect: RenderTile['rect'] = [size, (x % scale) * size, (coords.y % scale) * size];
            return { data, rect, tex: null, colored: null, clamps: null };
        };
        const deleted = (_coords: Coords, tile: RenderTile | null): void => {
            if (!tile) {
                return;
            }
            gl?.deleteTexture(tile.tex);
            if (provider.release(tile.data) && tile.data.gpu) {
                gl?.deleteTexture(tile.data.gpu.tex);
                gl?.deleteTexture(tile.data.gpu.nodataTex);
                gl?.deleteTexture(tile.data.gpu.zsTex);
                tile.data.gpu = null;
            }
        };
        return { provider, cache: new L.TileCache<RenderTile>(load, deleted) };
    }

    function updateCaches(): void {
        if (!map) {
            return;
        }
        const z = viewTileZ(map);
        current?.cache.update(viewTileBounds(map, z) as unknown as L.Bounds, z);
    }

    function repaintLater(): void {
        repaintTimer ??= setTimeout(() => {
            repaintTimer = null;
            map?.triggerRepaint();
        }, UPLOAD_INTERVAL_MS);
    }

    // Uploads a data tile's current values (only from prerender): flat, one RG32F texture; bands, an R16F 2D array
    // texture (257² × K layers, °C), an R8 nodata mask and the R32F model terrain, all read with texelFetch. A 2D array,
    // not 3D: WebGL2 guarantees only 256 texels per 3D dimension, but 256 array layers of up to 2048².
    function upload(provider: DataTileProvider, data: DataTile, now: number): void {
        if (!gl) {
            return;
        }
        if (provider.bands && maxLayers === null) {
            maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number;
        }
        if (!provider.bands) {
            const { rg, range } = provider.pack(data);
            if (data.gpu) {
                gl.bindTexture(gl.TEXTURE_2D, data.gpu.tex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, 257, 257, 0, gl.RG, gl.FLOAT, rg);
            }
            const tex = data.gpu?.tex ?? createTexture(gl, [gl.RG32F, gl.RG, gl.FLOAT], 257, 257, rg, gl.NEAREST);
            const gpu = { tex, nodataTex: null, zsTex: null, zs: null, bands: null };
            data.gpu = { ...gpu, version: data.version, uploadedAt: now, range };
        } else {
            const { values, nodata, zs, oLo, S, K, range } = provider.packBands(data);
            if (K > maxLayers!) {
                if (!layersWarned) {
                    layersWarned = true;
                    console.error(`[alpine-planner] ${K} bands exceed MAX_ARRAY_TEXTURE_LAYERS ${maxLayers}: not drawn`);
                }
                return;
            }
            const tex = data.gpu?.tex ?? gl.createTexture()!;
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
            gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R16F, 257, 257, K, 0, gl.RED, gl.FLOAT, values);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); // R8 rows are 257 bytes
            const replace = (target: WebGLTexture, format: [number, number, number], pixels: ArrayBufferView): void => {
                gl!.bindTexture(gl!.TEXTURE_2D, target);
                gl!.texImage2D(gl!.TEXTURE_2D, 0, format[0], 257, 257, 0, format[1], format[2], pixels);
            };
            const r8: [number, number, number] = [gl.R8, gl.RED, gl.UNSIGNED_BYTE];
            const r32f: [number, number, number] = [gl.R32F, gl.RED, gl.FLOAT];
            if (data.gpu?.nodataTex) {
                replace(data.gpu.nodataTex, r8, nodata); // z_s doesn't change
            }
            const nodataTex = data.gpu?.nodataTex ?? createTexture(gl, r8, 257, 257, nodata, gl.NEAREST);
            const zsTex = data.gpu?.zsTex ?? createTexture(gl, r32f, 257, 257, zs, gl.NEAREST);
            const bands = { oLo, S, K };
            data.gpu = { tex, nodataTex, zsTex, zs, bands, version: data.version, uploadedAt: now, range };
        }
        counts.uploads++;
        counts.lastUploadMs = performance.now() - now;
        counts.lastUploadAt = now;
    }

    // The elevation for a render tile (bands): our tile at min(z, 10), or a loaded ancestor up to MAX_LOWER_ZOOM
    // coarser, and the render tile's sub-rectangle in it. Missing tiles at the wanted zoom are loaded; from prerender
    // only (it uploads textures).
    // Algorithm: docs/forecast-layer-algorithm.md §7.6
    function elevationFor({ x, y, z }: Coords): Elevation | null {
        const wx = wrapX(x, z);
        const wanted = Math.min(z, MAX_TILE_ZOOM);
        for (let zE = wanted; zE >= Math.max(wanted - MAX_LOWER_ZOOM, 0); zE--) {
            const n = 2 ** (z - zE);
            const [ex, ey] = [Math.floor(wx / n), Math.floor(y / n)];
            const key = `${zE}/${ex}/${ey}`;
            let entry = elevationTextures.get(key);
            const tile = entry?.tile ?? cachedElevationTile(zE, ex, ey);
            if (!tile) {
                if (zE === wanted && !elevationRequested.has(key)) {
                    elevationRequested.add(key);
                    loadElevationTile(zE, ex, ey)
                        .then(() => map?.triggerRepaint())
                        .catch(() => {})
                        .finally(() => elevationRequested.delete(key));
                }
                continue;
            }
            if (entry) {
                elevationTextures.delete(key); // most recently used goes last
            } else {
                const r8: [number, number, number] = [gl!.R8, gl!.RED, gl!.UNSIGNED_BYTE];
                entry = { tex: createTexture(gl!, r8, 257, 257, tile.grid, gl!.LINEAR), tile };
            }
            elevationTextures.set(key, entry);
            if (elevationTextures.size > ELEVATION_TEXTURES) {
                const [oldestKey, oldest] = elevationTextures.entries().next().value!;
                gl!.deleteTexture(oldest.tex);
                elevationTextures.delete(oldestKey);
            }
            return { ...entry, zE, rect: [(wx % n) / n, (y % n) / n, 1 / n] };
        }
        return null;
    }

    // The elevation nodes of a render tile's rectangle whose height relative to the model terrain, h − z_s (z_s
    // bilinear, as the shader takes it), lies outside the bands: drawn with the nearest band (debug).
    function countClamps(
        { min, step, grid }: ElevationTile,
        [ox, oy, s]: Rect,
        [size, dx, dy]: RenderTile['rect'],
        zs: Float32Array,
        { oLo, S, K }: { oLo: number; S: number; K: number },
    ) {
        const [c0, c1] = [Math.floor(ox * 256), Math.ceil((ox + s) * 256)];
        const [r0, r1] = [Math.floor(oy * 256), Math.ceil((oy + s) * 256)];
        const oHi = oLo + S * (K - 1);
        let outside = 0;
        for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
                // the elevation node in data pixels (data node k at k), clamped to the tile
                const u = Math.min(Math.max(((c / 256 - ox) / s) * size + dx, 0), 256);
                const v = Math.min(Math.max(((r / 256 - oy) / s) * size + dy, 0), 256);
                const [i, j] = [Math.min(Math.floor(u), 255), Math.min(Math.floor(v), 255)];
                const [fu, fv] = [u - i, v - j];
                const n = j * 257 + i;
                const z0 = zs[n] + (zs[n + 1] - zs[n]) * fu;
                const z1 = zs[n + 257] + (zs[n + 258] - zs[n + 257]) * fu;
                const rel = min + step * grid[r * 257 + c] - (z0 + (z1 - z0) * fv);
                outside += rel < oLo || rel > oHi ? 1 : 0;
            }
        }
        return { outside, nodes: (r1 - r0 + 1) * (c1 - c0 + 1) };
    }

    // Colours one render tile into its texture (pass 1): flat, COLOR_FS; bands, the band shader with the tile's
    // elevation (not coloured until some elevation is loaded). Only from prerender: it binds our framebuffer.
    function colorTile(tile: RenderTile, coords: Coords): void {
        const gpu = tile.data.gpu;
        const elevation = gpu?.bands ? elevationFor(coords) : null;
        const program = gpu?.bands ? bandProgram : colorProgram;
        if (!gl || !program || !gpu || (gpu.bands && !elevation)) {
            return;
        }
        const rgba8: [number, number, number] = [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE];
        tile.tex ??= createTexture(gl, rgba8, TEXTURE_SIZE, TEXTURE_SIZE, null, gl.LINEAR);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tile.tex, 0);
        gl.viewport(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
        gl.useProgram(program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gpu.bands ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D, gpu.tex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, lutTex);
        gl.uniform1i(loc(program, gpu.bands ? 'u_bands' : 'u_data'), 0);
        gl.uniform1i(loc(program, 'u_lut'), 1);
        gl.uniform2f(loc(program, 'u_lutScaleOffset'), lut.mul, lut.add);
        gl.uniform3f(loc(program, 'u_rect'), ...tile.rect);
        gl.uniform2f(loc(program, 'u_range'), ...gpu.range);
        if (gpu.bands && elevation) {
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, gpu.nodataTex);
            gl.activeTexture(gl.TEXTURE3);
            gl.bindTexture(gl.TEXTURE_2D, elevation.tex);
            gl.activeTexture(gl.TEXTURE4);
            gl.bindTexture(gl.TEXTURE_2D, gpu.zsTex);
            gl.uniform1i(loc(program, 'u_nodata'), 2);
            gl.uniform1i(loc(program, 'u_elev'), 3);
            gl.uniform1i(loc(program, 'u_zs'), 4);
            gl.uniform3f(loc(program, 'u_elevRect'), ...elevation.rect);
            gl.uniform2f(loc(program, 'u_elevMinStep'), elevation.tile.min, elevation.tile.step);
            gl.uniform3f(loc(program, 'u_bandGeom'), gpu.bands.oLo, gpu.bands.S, gpu.bands.K);
        }
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        for (const unit of [gl.TEXTURE4, gl.TEXTURE3, gl.TEXTURE2, gl.TEXTURE1, gl.TEXTURE0]) {
            gl.activeTexture(unit);
            gl.bindTexture(gl.TEXTURE_2D, null);
        }
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
        tile.colored = { version: gpu.version, lutVersion, elevZ: elevation?.zE ?? null };
        if (gpu.bands && elevation) {
            tile.clamps = countClamps(elevation.tile, elevation.rect, tile.rect, gpu.zs!, gpu.bands);
        }
        counts.colored++;
    }

    // Uploads changed data tiles and colours the render tiles that need it; returns the pyramid to draw.
    function prepare(set: TileSet, bounds: L.Bounds, z: number, now: number): Coords[] {
        const pyramid = set.cache.getOrderedTilePyramid(bounds, z, MAX_LOWER_ZOOM, 0);
        for (const coords of pyramid) {
            const tile = set.cache.getData(coords);
            const data = tile?.data;
            if (!tile || !data || data.version === 0) {
                continue;
            }
            if (data.gpu?.version !== data.version) {
                if (!data.gpu || data.complete || now - data.gpu.uploadedAt >= UPLOAD_INTERVAL_MS) {
                    upload(set.provider, data, now);
                } else {
                    repaintLater();
                }
            }
            const gpu = data.gpu;
            const stale = tile.colored?.version !== gpu?.version || tile.colored?.lutVersion !== lutVersion;
            // bands: also when finer elevation has arrived
            const finer = gpu?.bands && (elevationFor(coords)?.zE ?? -1) > (tile.colored?.elevZ ?? -1);
            if (gpu && (stale || finer)) {
                colorTile(tile, coords);
            }
        }
        return pyramid;
    }

    // Every render tile of the view at zoom z is coloured (bands also need their elevation).
    const covered = (set: TileSet, pyramid: Coords[], z: number): boolean =>
        set.cache.requestedTilesCount > 0 &&
        set.cache.pendingTilesCount === 0 &&
        pyramid.filter(c => c.z === z).every(c => set.cache.getData(c)?.colored);

    // GPU bytes of the data tiles' textures, current and previous set.
    function dataBytes(): number {
        const seen = new Set<DataTile>();
        for (const set of [current, previous]) {
            for (const { pyramid } of toDraw.filter(d => d.set === set)) {
                pyramid.forEach(c => set && seen.add(set.cache.getData(c)?.data as DataTile));
            }
        }
        let bytes = 0;
        for (const data of seen) {
            const gpu = data?.gpu;
            bytes += !gpu ? 0 : gpu.bands ? 257 * 257 * (2 * gpu.bands.K + 1 + 4) : 257 * 257 * 8;
        }
        return bytes;
    }

    function setProvider(provider: DataTileProvider): void {
        if (provider === (current?.provider ?? pendingProvider)) {
            return;
        }
        if (!gl) {
            pendingProvider = provider;
            return;
        }
        // The previous set stays as the fallback unless the current one covered the view (fast dragging creates
        // several sets; one that never drew the whole view isn't worth keeping).
        if (current && previous && !currentCovered) {
            current.cache.dispose();
        } else {
            previous?.cache.dispose();
            previous = current;
            previousSince = Date.now();
        }
        current = createTileSet(provider);
        currentCovered = false;
        updateCaches();
        map?.triggerRepaint();
    }

    return {
        id,
        type: 'custom',
        renderingMode: '2d',

        onAdd(mapInstance: L.MapLibreMap, glContext: WebGLRenderingContext | WebGL2RenderingContext) {
            map = mapInstance;
            if (!(glContext instanceof WebGL2RenderingContext)) {
                console.warn('[alpine-planner] the forecast layer requires WebGL2, which is not available here');
                return;
            }
            gl = glContext;
            colorProgram = createProgram(gl, COLOR_VS, COLOR_FS);
            try {
                bandProgram = createProgram(gl, COLOR_VS, COLOR_BANDS_FS);
            } catch (err) {
                console.error('[alpine-planner] the band colour shader failed: the correction is not drawn', err);
            }
            drawProgram = createProgram(gl, DRAW_VS, DRAW_FS);
            quadBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
            fbo = gl.createFramebuffer();
            map.on('move', updateCaches);
            if (pendingProvider) {
                setProvider(pendingProvider);
                pendingProvider = null;
            }
        },

        onRemove() {
            map?.off('move', updateCaches);
            if (repaintTimer) {
                clearTimeout(repaintTimer);
            }
            current?.cache.dispose(); // releases the data tiles and deletes the textures
            previous?.cache.dispose();
            current = null;
            previous = null;
            toDraw = [];
            if (gl) {
                gl.deleteProgram(colorProgram);
                gl.deleteProgram(bandProgram);
                elevationTextures.forEach(({ tex }) => gl!.deleteTexture(tex));
                elevationTextures.clear();
                gl.deleteProgram(drawProgram);
                gl.deleteBuffer(quadBuffer);
                gl.deleteFramebuffer(fbo);
                gl.deleteTexture(lutTex);
            }
            map = null;
            gl = null;
            maxLayers = null;
        },

        prerender() {
            toDraw = [];
            if (!map || !gl || !current || isGlobeActive()) {
                return;
            }
            if (lutUploaded !== lutVersion) {
                gl.deleteTexture(lutTex);
                lutTex = createTexture(gl, [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE], lut.width, 1, lut.pixels, gl.LINEAR);
                lutUploaded = lutVersion;
            }

            const z = viewTileZ(map);
            lastTileZ = z;
            const bounds = viewTileBounds(map, z) as unknown as L.Bounds;
            const now = performance.now();
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); // R8 rows (elevation, nodata) are 257 bytes
            gl.disable(gl.BLEND);
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.STENCIL_TEST);
            gl.disable(gl.SCISSOR_TEST);
            gl.disable(gl.CULL_FACE);
            gl.colorMask(true, true, true, true);
            const aLocal = gl.getAttribLocation(colorProgram!, 'aLocal');
            gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
            gl.enableVertexAttribArray(aLocal);
            gl.vertexAttribPointer(aLocal, 2, gl.FLOAT, false, 0, 0);

            const pyramid = prepare(current, bounds, z, now);
            toDraw.push({ set: current, pyramid });
            currentCovered ||= covered(current, pyramid, z);
            if (previous && (currentCovered || Date.now() - previousSince > PREVIOUS_MAX_MS)) {
                previous.cache.dispose();
                previous = null;
            }
            if (previous) {
                toDraw.push({ set: previous, pyramid: prepare(previous, bounds, z, now) });
            }
        },

        render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: L.CustomRenderMethodInput) {
            if (!map || !gl || !drawProgram || toDraw.length === 0) {
                return;
            }
            renders++;
            const worldSize = 512 * 2 ** map.getZoom();

            gl.useProgram(drawProgram);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.CULL_FACE);
            // Overlapping tiles (an ancestor plus loaded children, the previous set): the first drawn wins each pixel.
            gl.enable(gl.STENCIL_TEST);
            gl.stencilMask(0xff);
            gl.clearStencil(0);
            gl.clear(gl.STENCIL_BUFFER_BIT);
            gl.stencilFunc(gl.NOTEQUAL, 1, 0xff);
            gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);

            const aLocal = gl.getAttribLocation(drawProgram, 'aLocal');
            gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
            gl.enableVertexAttribArray(aLocal);
            gl.vertexAttribPointer(aLocal, 2, gl.FLOAT, false, 0, 0);
            gl.activeTexture(gl.TEXTURE0);
            gl.uniform1i(loc(drawProgram, 'u_tile'), 0);
            const matrix = args.modelViewProjectionMatrix as unknown as Float32Array;
            gl.uniformMatrix4fv(loc(drawProgram, 'u_matrix'), false, matrix);
            const uQuadBounds = loc(drawProgram, 'u_quadBounds');

            for (const { set, pyramid } of toDraw) {
                for (let i = pyramid.length - 1; i >= 0; i--) {
                    const { x, y, z } = pyramid[i];
                    const tile = set.cache.getData(pyramid[i]);
                    if (!tile?.tex || !tile.colored) {
                        continue;
                    }
                    const s = worldSize / 2 ** z;
                    gl.uniform4f(uQuadBounds, x * s, y * s, (x + 1) * s, (y + 1) * s);
                    gl.bindTexture(gl.TEXTURE_2D, tile.tex);
                    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                }
            }

            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.disable(gl.STENCIL_TEST);
            gl.disable(gl.BLEND);
            // As Windy's temperature layer: alpha = 1 everywhere, and MapLibre must redraw its stencil masks.
            gl.colorMask(false, false, false, true);
            gl.clearColor(0, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.colorMask(true, true, true, true);
            (map as unknown as { painter?: { clearStencil?: () => void } }).painter?.clearStencil?.();
        },

        setProvider,

        repaint() {
            map?.triggerRepaint();
        },

        refreshColors() {
            lut = tempColorLut();
            lutVersion++;
            map?.triggerRepaint();
        },

        bandClampsAt({ lng, lat }) {
            const drawn = toDraw.find(d => d.set === current);
            if (!drawn || lastTileZ === null) {
                return null;
            }
            const n = 2 ** lastTileZ;
            const [x, y] = [Math.floor(wrapX(((lng + 180) / 360) * n, lastTileZ)), Math.floor(mercatorY(lat) * n)];
            const at = (c: Coords) => drawn.set.cache.getData(c);
            const under = drawn.pyramid.find(c => c.z === lastTileZ && wrapX(c.x, c.z) === x && c.y === y);
            const data = under && at(under)?.data;
            let outside = 0;
            let nodes = 0;
            for (const c of drawn.pyramid) {
                const clamps = data && at(c)?.data === data ? at(c)?.clamps : null;
                outside += clamps?.outside ?? 0;
                nodes += clamps?.nodes ?? 0;
            }
            return nodes > 0 ? { outside, nodes } : null;
        },

        getDebugCounts(): LayerCounts {
            return {
                tileZ: lastTileZ,
                dataZ: current && lastTileZ !== null ? current.provider.dataZoom(lastTileZ) : null,
                renderTiles: current?.cache.cachedTilesCount ?? 0,
                previous: previous !== null,
                ...counts,
                renders,
                dataMB: dataBytes() / 1e6,
                elevationTextures: elevationTextures.size,
            };
        },
    };
}

// Constants for the terrain mask. How the plugin integrates with Windy's map is described in
// docs/windy-integration.md.

// The global terrain elevation layer, served from Windy's tile server as a static pseudo-model in the `analysis`
// category (reference time == valid time, fixed reftime).
export const TILES_ORIGIN = 'https://ims.windy.com';
export const ELEVATION_REFTIME = '2026100700';
export const MIN_TILE_ZOOM = 0;
export const MAX_TILE_ZOOM = 10;
export const tileUrl = (z: number, x: number, y: number) =>
    `${TILES_ORIGIN}/im/v3.0/analysis/elevation/${ELEVATION_REFTIME}/${ELEVATION_REFTIME}/wm_grid_257/${z}/${x}/${y}/elevation-surface.jpg`;

// Freezing-mask fields, lossless PNG (see docs/freezing-mask-algorithm.md §2): from a forecast step
// `deg0-surface` and, for the lapse rate correction, `temp-surface` (Kelvin) and `temp-<level>` / `gh-<level>`; the
// model terrain (`gh-surface`) from the model's analysis. `addTileAuthParams` is applied by the caller.
export const forecastTileUrl = (directory: string, refTime: string, path: string, z: number, x: number, y: number, file: string) =>
    `${TILES_ORIGIN}/im/v3.0/${directory}/${refTime}/${path}/wm_grid_257/${z}/${x}/${y}/${file}.png`;
export const terrainTileUrl = (modelDir: string, aref: string, z: number, x: number, y: number) =>
    `${TILES_ORIGIN}/im/v3.0/analysis/${modelDir}/${aref}/${aref}/wm_grid_257/${z}/${x}/${y}/gh-surface.png`;

// Pressure levels for the lapse rate profile (Windy's level tokens); each model uses those it lists in
// `product.levels`.
export const PROFILE_LEVELS = ['950h', '925h', '900h', '850h', '800h', '700h', '600h', '500h'];

// A far-future analysis reftime: the tile server redirects it to the model's active analysis run.
export const ANALYSIS_LATEST_REFTIME = '2099010100';

// Model terrain tiles kept for the session (all models together); ~330 kB each decoded.
export const TERRAIN_CACHE_SIZE = 64;

// Used when the selected product has no deg0.
export const DEG0_FALLBACK_PRODUCT = 'ecmwf';

// Re-resolve the model run this often, to pick up new runs (Windy's minifest refreshes about as often).
export const DEG0_REFRESH_MS = 10 * 60 * 1000;

// While a new deg0 context loads, the previous one's tiles fill in; they are dropped at the latest after this.
export const DEG0_PREVIOUS_MAX_MS = 10 * 1000;

// A replaced window cache is disposed a little later, so the new one has registered the step tile fetches it shares.
export const WINDOW_RETIRE_DELAY_MS = 100;

// The isotherm window's handles settle this long before a new fold set is made (dragging).
export const WINDOW_DEBOUNCE_MS = 150;

export const LAYER_ID = 'alpine-planner-elevation-mask';

// Between @windy/map's layerOrder LANDMASK_SEAMASK (300) and BASE_MAP (400), so the mask dims weather colours and
// particles but stays below borders, lakes and topo detail (docs/windy-integration.md).
export const LAYER_BUCKET = 350;

// From MapLibre zoom grayMapZoomEnd - 0.5 Windy paints the opaque topo map in
// buckets 400/401, covering bucket 350. Above it, like Windy's own wind
// particles, move above the topo map: over TOPO_MAP (401) and
// below PARTICLES_HIGH_ZOOM (450).
export const LAYER_BUCKET_HIGH_ZOOM = 440;

// Fixed, no UI control.
export const MASK_OPACITY = 0.65;

// Isotherm Both (docs/freezing-mask-algorithm.md §6.4, provisional): the dimming between F_min and F_max, and the line
// along F_max (in the dimming colour at MASK_OPACITY).
export const BOTH_BAND_OPACITY = 0.3;
export const BOTH_LINE_WIDTH_PX = 1.5;

export const MIN_ELEVATION = 500;
export const MAX_ELEVATION = 8000; // slider top; means "no upper limit"
export const ELEVATION_STEP = 10;
export const MIN_RANGE_GAP = 100;
export const DEFAULT_FROM = 1700;
export const DEFAULT_TO = MAX_ELEVATION;

// Freezing mask: terrain below the freezing level + offset is dimmed.
export const MIN_OFFSET = -500;
export const MAX_OFFSET = 500;
export const OFFSET_STEP = 10;
export const DEFAULT_OFFSET = 0;

// How many zoom levels coarser than tileZ an ancestor fallback may be, so
// zooming in shows a blurred parent immediately instead of nothing.
export const MAX_LOWER_ZOOM_ALLOWED = 4;

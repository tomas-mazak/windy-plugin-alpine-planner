// The freezing-mask data source: which model, run and step(s) of the freezing level (deg0) to draw, resolved from
// Windy's selected product, and for Instant its timeline time. See docs/freezing-mask-algorithm.md §2.

import { addTileAuthParams } from '@windy/authParams';
import bcast from '@windy/broadcast';
import products from '@windy/products';
import store from '@windy/store';
import { hasAny } from '@windy/subscription';

import { isFreeTime, selectSteps, type StepSelection } from '../../lib/steps';
import { fetchWindyTile, windyTileValues, type WindyTile } from '../../lib/windyTile';
import {
    ANALYSIS_LATEST_REFTIME,
    DEG0_FALLBACK_PRODUCT,
    DEG0_REFRESH_MS,
    forecastTileUrl,
    PROFILE_LEVELS,
    TERRAIN_CACHE_SIZE,
    terrainTileUrl,
} from './constants';

import type { Calendar } from '@windy/Calendar';
import type { Product } from '@windy/Product';

// The mask's model and run (what Min / Max / Both need), independent of Windy's timeline time.
export type Deg0Model =
    | {
          ok: true;
          productIdent: string;
          name: string; // e.g. "ECMWF"
          label: string; // e.g. "ECMWF · run 07.10. 12 UTC"
          directory: string;
          refTime: string;
          calendar: Calendar;
          premium: boolean;
          maxZoom: number;
          levels: string[]; // pressure levels for the lapse rate profile, e.g. '950h'
          key: string; // product and run
      }
    | { ok: false; reason: string };

export type Deg0ModelOk = Extract<Deg0Model, { ok: true }>;

// Instant: the model's step at Windy's timeline time.
export type Deg0Context =
    | { ok: true; model: Deg0ModelOk; timestamp: number; path: string; key: string }
    | { ok: false; reason: string };

export type Deg0ContextOk = Extract<Deg0Context, { ok: true }>;

// Min / Max / Both: the window's steps of the model (docs/freezing-mask-algorithm.md §6.2).
export type Deg0WindowContext = { model: Deg0ModelOk; selection: StepSelection; paths: string[]; key: string };

const productsByIdent = products as unknown as Record<string, Product | undefined>;

// '2026100712' -> '07.10. 12 UTC' (the refTime is already UTC)
const formatRun = (refTime: string): string => `${refTime.slice(6, 8)}.${refTime.slice(4, 6)}. ${refTime.slice(8, 10)} UTC`;

// Algorithm: docs/freezing-mask-algorithm.md §2
export async function resolveDeg0Model(): Promise<Deg0Model> {
    const selected = store.get('product');
    const ident = productsByIdent[selected]?.overlays.includes('deg0') ? selected : DEG0_FALLBACK_PRODUCT;
    const product = productsByIdent[ident]!;
    const name = product.modelName || ident;
    try {
        const [refTime, calendar] = await Promise.all([product.getRefTime(), product.getCalendar()]);
        if (!refTime || !calendar) {
            return { ok: false, reason: `${name}: data unavailable` };
        }
        const premium = hasAny();
        return {
            ok: true,
            productIdent: ident,
            name,
            label: `${name} · run ${formatRun(refTime)}`,
            directory: product.directory,
            refTime,
            calendar,
            premium,
            maxZoom: (premium ? product.maxTileZoom?.premium : product.maxTileZoom?.free) ?? 3,
            levels: PROFILE_LEVELS.filter(level => (product.levels as string[] | undefined)?.includes(level)),
            key: `${ident}/${refTime}`,
        };
    } catch (err) {
        console.warn('[alpine-planner] resolving the deg0 model failed', err);
        return { ok: false, reason: `${name}: data unavailable` };
    }
}

// Algorithm: docs/freezing-mask-algorithm.md §2
export function instantContext(model: Deg0Model, timestamp: number): Deg0Context {
    if (!model.ok) {
        return model;
    }
    const { calendar, name } = model;
    if (timestamp < calendar.start || timestamp > calendar.end) {
        return { ok: false, reason: `Time outside ${name} forecast` };
    }
    if (!isFreeTime(timestamp, calendar.premiumStart, model.premium)) {
        return { ok: false, reason: 'Premium time' };
    }
    const path = calendar.ts2path(timestamp);
    return { ok: true, model, timestamp, path, key: `${model.key}/${path}` };
}

// The free forecast horizon of the window: premiumStart for free users, none for premium users.
export const premiumLimit = (model: Deg0ModelOk): number | null => (model.premium ? null : model.calendar.premiumStart);

// Algorithm: docs/freezing-mask-algorithm.md §6.2
export function windowContext(model: Deg0ModelOk, window: { start: number; end: number }): Deg0WindowContext {
    const selection = selectSteps(model.calendar, window, model.premium);
    return {
        model,
        selection,
        paths: selection.steps.map(ts => model.calendar.ts2path(ts)),
        key: `${model.key}/${model.premium ? 'premium' : 'free'}/${selection.steps.join(',')}`,
    };
}

// A field of one of the model's steps, e.g. 'deg0-surface', 'temp-surface' (K), 'temp-850h' (K), 'gh-850h' (m).
export const forecastUrl = (model: Deg0ModelOk, path: string, file: string, z: number, x: number, y: number): string =>
    addTileAuthParams(forecastTileUrl(model.directory, model.refTime, path, z, x, y, file));

// --- Model terrain (static per model, from its analysis) ---

// 'forecast/ecmwf-hres' -> 'ecmwf-hres'
const modelDir = (directory: string): string => directory.replace(/^forecast\//, '');

// The active analysis reftime per model dir, resolved once per session.
const arefs = new Map<string, Promise<string>>();
const resolvedArefs = new Map<string, string>();

export const getAref = (directory: string): string | undefined => resolvedArefs.get(modelDir(directory));

// The model's first terrain tile is requested with a far-future reftime; the tile server redirects it to the active
// analysis run, read from the final URL. Concurrent and later requests wait for that and use the resolved URL, so
// there's one redirect per model.
async function fetchTerrainTile(dir: string, z: number, x: number, y: number): Promise<WindyTile> {
    const aref = arefs.get(dir);
    if (aref) {
        return fetchWindyTile(addTileAuthParams(terrainTileUrl(dir, await aref, z, x, y)), 'png');
    }
    const first = fetchWindyTile(addTileAuthParams(terrainTileUrl(dir, ANALYSIS_LATEST_REFTIME, z, x, y)), 'png');
    const resolved = first.then(tile => {
        const found = /\/analysis\/[^/]+\/(\d{10})\//.exec(tile.url)?.[1];
        if (!found) {
            throw new Error(`no analysis reftime in ${tile.url}`);
        }
        resolvedArefs.set(dir, found);
        return found;
    });
    arefs.set(dir, resolved);
    resolved.catch(() => arefs.delete(dir)); // retried by the next tile
    return first;
}

export type TerrainGrid = { values: Float32Array; step: number }; // metres, NaN = no data

// Kept for the session across time and run changes; a small LRU over all models. Not aborted: other tiles may wait
// for the same promise.
const terrainCache = new Map<string, Promise<TerrainGrid>>();

// Algorithm: docs/freezing-mask-algorithm.md §2
export function loadTerrain(directory: string, z: number, x: number, y: number): Promise<TerrainGrid> {
    const dir = modelDir(directory);
    const key = `${dir}/${z}/${x}/${y}`;
    let grid = terrainCache.get(key);
    if (grid) {
        terrainCache.delete(key); // most recently used goes last
    } else {
        grid = fetchTerrainTile(dir, z, x, y).then(tile => ({ values: windyTileValues(tile), step: tile.header.step }));
        const loading = grid;
        loading.catch(() => terrainCache.get(key) === loading && terrainCache.delete(key));
    }
    terrainCache.set(key, grid);
    if (terrainCache.size > TERRAIN_CACHE_SIZE) {
        terrainCache.delete(terrainCache.keys().next().value!);
    }
    return grid;
}

// Resolves the model and Instant's step now, on product / timestamp / params / subscription changes and periodically
// (new runs). Only the latest resolution is reported. Returns the unsubscribe function.
export function watchDeg0Context(onChange: (model: Deg0Model, instant: Deg0Context) => void): () => void {
    let latest = 0;
    const refresh = (): void => {
        const request = ++latest;
        void resolveDeg0Model().then(model => {
            if (request === latest) {
                onChange(model, instantContext(model, store.get('timestamp')));
            }
        });
    };

    store.on('product', refresh);
    store.on('timestamp', refresh);
    store.on('subscription', refresh);
    bcast.on('paramsChanged', refresh);
    const interval = setInterval(refresh, DEG0_REFRESH_MS);
    refresh();

    return () => {
        latest++; // drops a resolution still in flight
        store.off('product', refresh);
        store.off('timestamp', refresh);
        store.off('subscription', refresh);
        bcast.off('paramsChanged', refresh);
        clearInterval(interval);
    };
}

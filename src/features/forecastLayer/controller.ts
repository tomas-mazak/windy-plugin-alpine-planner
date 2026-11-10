// The forecast layer: Min / Max over a time window and the lapse rate correction. When active: the steps,
// one source per context, our layer and the Windy patches (docs/forecast-layer-algorithm.md,
// docs/windy-integration.md). Active for temperature at the surface outside the 3D globe, in Min or Max, or in
// Instant with the correction (on Windy's normal timeline, without the range control); otherwise every patch is
// restored.

import bcast from '@windy/broadcast';
import { layerOrder, map } from '@windy/map';
import metrics from '@windy/metrics';
import products from '@windy/products';
import store from '@windy/store';
import { hasAny } from '@windy/subscription';

import { loadTerrain } from '../elevationMask/deg0';
import { PROFILE_LEVELS } from '../elevationMask/constants';
import { createCorrectedSource } from './correctedSource';
import { createFoldSource, type FoldChange, type FoldContext, type ForecastSource } from './foldSource';
import { createForecastMapLayer, type ForecastMapLayer } from './layer';
import { selectSteps, type StepSelection } from '../../lib/steps';
import { pickerDataZoom, watchTempParams, type TempParams } from './tempTiles';
import {
    createInterpolator,
    notifyPickerDataChanged,
    restoreAll,
    setInterpolatorOverride,
    setPickerDecorator,
    setRangeControl,
    setWindyLayerHidden,
    watchRangeWindow,
    type RangeWindow,
} from './windyHooks';

import type { FoldKind } from './fold';

import { mercatorX, mercatorY } from '../../lib/mercator';
import { formatWindyTime } from '../../lib/windyTime';

import type { Product } from '@windy/Product';

export type ForecastMode = 'instant' | 'min' | 'max';

export type ForecastState = {
    mode: ForecastMode;
    active: boolean;
    reason: 'not temperature at surface' | 'globe' | null; // why the forecast layer can't be active now
    correction: boolean; // the checkbox
    correctionAvailable: boolean | null; // for the selected model: profile levels and model terrain; null: checking
    modelName: string;
    window: RangeWindow | null;
    selection: StepSelection | null;
    premiumStart: number | null;
    source: ForecastSource | null;
    layer: ForecastMapLayer | null;
};

const LAYER_ID = 'alpine-planner-forecast-layer';
const HOUR = 3600 * 1000;
const WINDOW_DEBOUNCE_MS = 150;
// A replaced source stops asking for step tiles a little later, so the new one has registered the fetches it shares.
const RETIRE_DELAY_MS = 100;
const PICKER_REFRESH_MS = 2000; // at most this often while loading

const wrapX = (x: number, z: number): number => ((x % 2 ** z) + 2 ** z) % 2 ** z;

const productsByIdent = products as unknown as Record<string, Product | undefined>;

const state: ForecastState = {
    mode: 'instant',
    active: false,
    reason: null,
    correction: false,
    correctionAvailable: null,
    modelName: '',
    window: null,
    selection: null,
    premiumStart: null,
    source: null,
    layer: null,
};

let started = false;
let params: TempParams | null = null; // Windy's current temp params
let sourceKey = '';
let stopWhileActive: (() => void)[] = [];
let resolveTimer: ReturnType<typeof setTimeout> | undefined;
let resolveRequest = 0;
let pickerRefreshedAt = 0;
let pickerRefreshTimer: ReturnType<typeof setTimeout> | undefined;

export const getForecastState = (): Readonly<ForecastState> => state;

// Plugin open, in the remembered (or default) mode and correction: Min / Max swaps the timeline for Windy's range
// selector as a click would.
export function startForecastLayer(mode: ForecastMode, correction: boolean): void {
    started = true;
    state.mode = mode;
    state.correction = correction;
    store.on('overlay', update);
    store.on('level', update);
    store.on('mapLibrary', update);
    store.on('product', checkCorrection);
    void checkCorrection();
    update();
}

// Plugin close: Windy is restored completely.
export function stopForecastLayer(): void {
    store.off('overlay', update);
    store.off('level', update);
    store.off('mapLibrary', update);
    store.off('product', checkCorrection);
    started = false;
    update();
}

export function setForecastMode(mode: ForecastMode): void {
    state.mode = mode;
    update();
}

export function setForecastCorrection(on: boolean): void {
    state.correction = on;
    update();
}

const correctionOn = (): boolean => state.correction && state.correctionAvailable === true;

function update(): void {
    const tempSurface = store.get('overlay') === 'temp' && store.get('level') === 'surface';
    state.reason = !tempSurface ? 'not temperature at surface' : store.get('mapLibrary') === 'globe' ? 'globe' : null;
    const active = started && !state.reason && (state.mode !== 'instant' || correctionOn());
    if (active && !state.active) {
        activate();
    } else if (!active && state.active) {
        deactivate();
    } else if (active) {
        setRangeControl(state.mode !== 'instant'); // Instant + correction keeps Windy's normal timeline
        scheduleResolve(0); // mode or correction changed
    }
}

// --- Correction availability ---

// The model's profile levels (as the isotherm's correction picks them).
const modelLevels = (product: Product | undefined): string[] =>
    PROFILE_LEVELS.filter(level => (product?.levels as string[] | undefined)?.includes(level));

// Whether each model's terrain resolves (its analysis gh-surface, via the aref redirect), per session.
const terrainChecks = new Map<string, Promise<boolean>>();

// The correction needs the model's terrain and at least one profile level.
async function checkCorrection(): Promise<void> {
    const ident = store.get('product');
    const product = productsByIdent[ident];
    state.modelName = product?.modelName || ident;
    state.correctionAvailable = modelLevels(product).length > 0 ? null : false;
    update();
    if (!product || state.correctionAvailable === false) {
        return;
    }
    let check = terrainChecks.get(product.directory);
    if (!check) {
        check = loadTerrain(product.directory, 0, 0, 0).then(
            () => true,
            () => false,
        );
        terrainChecks.set(product.directory, check);
    }
    const available = await check;
    if (store.get('product') === ident) {
        state.correctionAvailable = available;
        update();
    }
}

// --- Picker (docs/forecast-layer-algorithm.md §5) ---

// What each value array our interpolator returned stands for: the decorator gets the same array.
const extremes = new WeakMap<number[], { kind: FoldKind; instant: boolean; ts: number; height?: number }>();

// Algorithm: docs/forecast-layer-algorithm.md §5, §7.8
// The current source at the clicked point: the folded value, and the time of the point series' extreme; with the
// correction, at the real height there. Waits for missing steps unless Windy aborts.
const interpolator = createInterpolator(async (lat, lon, abort) => {
    const source = state.source;
    const sample = await source?.sample({ lng: lon, lat }, map.maplibreMap.getZoom(), abort?.signal);
    if (!source || !sample) {
        return null;
    }
    const values = [sample.value, 0, 0];
    const { kind, instant, steps } = source.context;
    extremes.set(values, { kind, instant, ts: steps[sample.stepIndex], height: sample.height });
    return values;
});

// In Windy's picker-subtext style: Min / Max puts "Max" / "Min" before Windy's value and the extreme's time on a
// second line, plus the real height with the correction ("Wed 14:00 · 1,840 m"); Instant + correction shows only the
// height. Heights use Windy's elevation metric (m / ft as the user set it).
function decoratePicker(html: string, values: number[]): string {
    const extreme = extremes.get(values);
    if (!extreme) {
        return html;
    }
    const height = extreme.height === undefined ? null : metrics.elevation.convertValue(Math.round(extreme.height));
    const line = (text: string): string => `<div class="picker-subtext">${text}</div>`;
    if (extreme.instant) {
        return height ? `${html}${line(height)}` : html;
    }
    const label = `<span class="picker-subtext">${extreme.kind === 'max' ? 'Max' : 'Min'}</span>`;
    return `${label} ${html}${line([formatWindyTime(extreme.ts), height].filter(Boolean).join(' · '))}`;
}

// Both pickers re-render with our (live) interpolator on dataChanged: at once when the data tile under the picker is
// complete, otherwise at most every PICKER_REFRESH_MS.
function refreshPicker(now: boolean): void {
    const wait = now ? 0 : pickerRefreshedAt + PICKER_REFRESH_MS - Date.now();
    clearTimeout(pickerRefreshTimer);
    pickerRefreshTimer = setTimeout(() => {
        pickerRefreshedAt = Date.now();
        notifyPickerDataChanged();
    }, Math.max(wait, 0));
}

// Whether a data tile holds the desktop picker, or the map centre for the mobile picker dot.
function isUnderPicker({ z, x, y }: FoldChange): boolean {
    const location = store.get('pickerLocation');
    const { lng, lat } = location ? { lng: location.lon, lat: location.lat } : map.maplibreMap.getCenter();
    if (!params || pickerDataZoom(params, map.maplibreMap.getZoom()) !== z) {
        return false;
    }
    const n = 2 ** z;
    return wrapX(Math.floor(mercatorX(lng) * n), z) === x && Math.floor(mercatorY(lat) * n) === y;
}

function onFoldChange(change: FoldChange): void {
    state.layer?.repaint();
    if (change.complete && isUnderPicker(change)) {
        refreshPicker(true);
    }
}

// --- Activation ---

function activate(): void {
    state.active = true;
    state.layer = createForecastMapLayer(LAYER_ID);
    map.addMapLibreOrderedLayerToBucket(state.layer, layerOrder.MAIN);
    setWindyLayerHidden(true);
    setRangeControl(state.mode !== 'instant');
    setInterpolatorOverride(interpolator);
    setPickerDecorator(decoratePicker);

    const resolveNow = (): void => scheduleResolve(0);
    const onPaletteChanged = (): void => state.layer?.refreshColors();
    store.on('subscription', resolveNow);
    bcast.on('redrawLayers', onPaletteChanged);
    stopWhileActive = [
        watchTempParams(p => {
            params = p; // model, new run, timeline step
            resolveNow();
        }),
        watchRangeWindow(() => scheduleResolve(WINDOW_DEBOUNCE_MS)),
        () => store.off('subscription', resolveNow),
        () => bcast.off('redrawLayers', onPaletteChanged),
    ];
}

function deactivate(): void {
    state.active = false;
    stopWhileActive.forEach(stop => stop());
    stopWhileActive = [];
    clearTimeout(resolveTimer);
    clearTimeout(pickerRefreshTimer);
    resolveRequest++; // drops a resolution in flight
    state.source?.retire();
    Object.assign(state, { source: null, window: null, selection: null, premiumStart: null });
    sourceKey = '';
    params = null;
    if (state.layer) {
        map.removeMapLibreOrderedLayer(LAYER_ID); // releases the folds and their textures
        state.layer = null;
    }
    restoreAll();
}

function scheduleResolve(delay: number): void {
    clearTimeout(resolveTimer);
    resolveTimer = setTimeout(() => void resolve(), delay);
}

// Algorithm: docs/forecast-layer-algorithm.md §2, §7.4
// The steps (Min / Max: the window's; Instant + correction: Windy's current step), and a new source when the steps,
// kind, model, run, premium status or the correction changed. A new run drops the folds; its step tiles stay in the
// LRU until evicted. Correction off is exactly the uncorrected Min / Max source (foldSource.ts).
async function resolve(): Promise<void> {
    const request = ++resolveRequest;
    const p = params;
    const calendar = p && (await productsByIdent[p.product]?.getCalendar());
    if (request !== resolveRequest || !p || !calendar || !state.layer) {
        return;
    }
    const instant = state.mode === 'instant';
    const premium = hasAny();
    let window: RangeWindow;
    let selection: StepSelection;
    if (instant) {
        const ts = calendar.timestamps.find(t => calendar.ts2path(t) === p.path) ?? store.get('timestamp');
        window = { start: ts, end: ts };
        selection = { steps: [ts], clipped: false, dropped: 0, spacingH: [] };
    } else {
        const start = store.get('timestamp');
        window = { start, end: start + store.get('acRange') * HOUR };
        selection = selectSteps(calendar, window, premium);
    }
    Object.assign(state, { window, selection, premiumStart: calendar.premiumStart });

    const kind = state.mode === 'min' ? 'min' : 'max'; // Instant: one step, either fold
    const correction = correctionOn();
    const base = p.fullPath.replace(`/${p.path}/`, '/');
    const key = [kind, instant, correction, premium, base, ...selection.steps].join('|');
    if (key === sourceKey) {
        return;
    }
    sourceKey = key;
    const old = state.source;
    const steps = selection.steps;
    const paths = steps.map(ts => calendar.ts2path(ts));
    const levels = modelLevels(productsByIdent[p.product]);
    const context: FoldContext = { kind, instant, correction, params: p, steps, paths, levels };
    state.source = (correction ? createCorrectedSource : createFoldSource)(context, onFoldChange);
    state.layer.setProvider(state.source);
    if (old) {
        setTimeout(() => old.retire(), RETIRE_DELAY_MS);
    }
    refreshPicker(false);
}

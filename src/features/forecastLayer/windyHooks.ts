// The only module that patches Windy internals (docs/windy-integration.md). Every setter is idempotent: it remembers Windy's original on first use and puts it back on
// null/false. restoreAll() undoes everything and is safe to call anytime. These are client internals, not plugin API,
// so a client release can break them; in debug mode every patch is logged and checked after each redrawFinished.

import bcast from '@windy/broadcast';
import { map } from '@windy/map';
import overlays from '@windy/overlays';
import { emitter as picker } from '@windy/picker';
import renderers from '@windy/renderers';
import store from '@windy/store';

import { tileXYToLngLat } from '../../lib/mercator';

import type { FullRenderParameters } from '@windy/interfaces';
import type { InterpolatorFactory } from '@windy/interpolator';

// Windy's interpolator functions (as @windy/interpolator hands them out). For temp, tileLayerInterpolator resolves
// to [K, 0, 0] (the temp tiles' G and B headers are 0..0), or null where there's no data or no tile loaded.
type LatLon = { lat: number; lon: number };
type LatLonFn = (latLon: LatLon, abort?: AbortController, params?: FullRenderParameters) => Promise<unknown>;
type XYFn = (x: number, y: number, abort?: AbortController, params?: FullRenderParameters) => Promise<unknown>;
type Factory = { createFun: (cb: (latLon: LatLonFn, xy: XYFn) => void) => void };

export type PickerDecorator = (html: string, values: number[]) => string;
export type RangeWindow = { start: number; end: number }; // ms

const HOUR = 3600 * 1000;

// All of Windy's tile layer renderers share one MapLibre layer, created by whichever opened first and named after it.
// It's 'tileLayer' unless the session started on e.g. an accumulation.
const TILE_LAYER_IDS = ['tileLayer', 'noUserControl', 'daySwitcher', 'accumulations', 'levelsRange', 'fireDanger'];

let debug = false;
let originalInterpolator: InterpolatorFactory | undefined;
let installedInterpolator: InterpolatorFactory | null = null;
let originalPickerHTML: typeof overlays.temp.createPickerHTML | null = null;
let installedPickerHTML: typeof overlays.temp.createPickerHTML | null = null;
let pickerDecorator: PickerDecorator | null = null;
let originalUserControl: typeof renderers.tileLayer.userControl;
let rangeControl = false;
let windyLayerHidden = false;

const log = (...args: unknown[]): void => {
    if (debug) {
        console.info('[alpine-planner] windyHooks:', ...args);
    }
};

const windyLayerId = (): string | undefined => TILE_LAYER_IDS.find(id => map.maplibreMap.getLayer(id));

// Windy re-reads interpolators (desktop and mobile picker on redrawFinished, the cities POI mode on paramsChanged) and
// switches the user control (the timeline or range selector) only when it broadcasts params. Re-setting an unsaved
// param with forceChange makes Windy broadcast its current params once, debounced with any real change.
function rebroadcastParams(): void {
    void store.set('levelsRange', store.get('levelsRange'), { forceChange: true });
}

// --- Interpolator ---

// Windy's own temperature interpolator, even while ours is installed.
const windyInterpolator = (): Factory | undefined =>
    (originalInterpolator ?? renderers.tileLayer.interpolator) as Factory | undefined;

// An interpolator with Windy's interface, sampling temperature with `sample`, which returns Windy's shape for temp,
// [K, 0, 0], or null for no data. The array reaches createPickerHTML unchanged, so a decorator can recognise it. The
// XY variant converts mercator pixels as Windy's does (256 px tiles at MapLibre zoom + 1). Calls that pass another
// layer's render params (the picker's wind companion row) go to Windy's interpolator.
export type Sampler = (lat: number, lon: number, abort?: AbortController) => Promise<number[] | null>;

export function createInterpolator(sample: Sampler): InterpolatorFactory {
    const factory: Factory = {
        createFun(cb) {
            let windyLatLon: LatLonFn = () => Promise.resolve(null);
            let windyXY: XYFn = () => Promise.resolve(null);
            windyInterpolator()?.createFun((latLon, xy) => ([windyLatLon, windyXY] = [latLon, xy])); // synchronous
            cb(
                (latLon, abort, params) =>
                    params && params.layer !== 'temp'
                        ? windyLatLon(latLon, abort, params)
                        : sample(latLon.lat, latLon.lon, abort),
                (x, y, abort, params) => {
                    if (params && params.layer !== 'temp') {
                        return windyXY(x, y, abort, params);
                    }
                    const worldPx = 256 * 2 ** (map.maplibreMap.getZoom() + 1);
                    const { lat, lng } = tileXYToLngLat(x / worldPx, y / worldPx, 0);
                    return sample(lat, lng, abort);
                },
            );
        },
    };
    return factory as unknown as InterpolatorFactory;
}

// Replaces renderers.tileLayer.interpolator (a plain property, set once in the TileLayer constructor), then makes the
// pickers and city labels re-read it.
export function setInterpolatorOverride(factory: InterpolatorFactory | null): void {
    if (factory === installedInterpolator) {
        return;
    }
    const tileLayer = renderers.tileLayer;
    if (factory) {
        if (!installedInterpolator) {
            originalInterpolator = tileLayer.interpolator;
        }
        tileLayer.interpolator = factory;
    } else {
        if (tileLayer.interpolator === installedInterpolator) {
            tileLayer.interpolator = originalInterpolator; // unless Windy replaced ours meanwhile: keep Windy's
        }
        originalInterpolator = undefined;
    }
    installedInterpolator = factory;
    log(factory ? 'interpolator override installed' : 'interpolator restored');
    notifyPickerDataChanged();
    rebroadcastParams();
}

// The desktop picker re-reads the interpolator and re-renders; the mobile picker re-renders with the function it has.
export function notifyPickerDataChanged(): void {
    picker.emit('dataChanged');
}

// --- Picker label ---

// Wraps overlays.temp.createPickerHTML (an own property, assigned in the Overlay constructor), which both the
// desktop and the mobile picker format with. `fn` gets Windy's HTML and the values and returns the HTML to show.
export function setPickerDecorator(fn: PickerDecorator | null): void {
    if (fn === pickerDecorator) {
        return;
    }
    const temp = overlays.temp;
    if (fn && !originalPickerHTML) {
        const original = temp.createPickerHTML;
        originalPickerHTML = original;
        installedPickerHTML = function (this: typeof temp, values, formatDir) {
            const html = original.call(this, values, formatDir);
            return pickerDecorator ? pickerDecorator(html, values) : html;
        };
        temp.createPickerHTML = installedPickerHTML;
    } else if (!fn && originalPickerHTML) {
        if (temp.createPickerHTML === installedPickerHTML) {
            temp.createPickerHTML = originalPickerHTML;
        }
        originalPickerHTML = null;
        installedPickerHTML = null;
    }
    pickerDecorator = fn;
    log(fn ? 'picker decorator installed' : 'picker decorator restored');
    notifyPickerDataChanged();
}

// --- Range control ---

// Swaps the tileLayer renderer's user control ('progress-bar' on desktop, 'mobile-calendar' on mobile) for Windy's
// accumulation range selector. Windy opens and closes the controls itself on the params broadcast, so its record of
// the open control stays consistent.
export function setRangeControl(on: boolean): void {
    if (on === rangeControl) {
        return;
    }
    const tileLayer = renderers.tileLayer;
    if (on) {
        originalUserControl = tileLayer.userControl;
        tileLayer.userControl = 'accumulations';
    } else {
        tileLayer.userControl = originalUserControl;
    }
    rangeControl = on;
    log(on ? 'range control on' : `user control restored (${String(originalUserControl)})`);
    rebroadcastParams();
}

// The window [timestamp, timestamp + acRange h]: now and on every change. acRange is the raw store value (fractional
// hours while dragging on desktop; Windy floors it only for its own params). Returns the unsubscribe function.
export function watchRangeWindow(onChange: (w: RangeWindow) => void): () => void {
    const emit = (): void => {
        const start = store.get('timestamp');
        onChange({ start, end: start + store.get('acRange') * HOUR });
    };
    store.on('timestamp', emit);
    store.on('acRange', emit);
    emit();
    return () => {
        store.off('timestamp', emit);
        store.off('acRange', emit);
    };
}

// --- Windy's layer ---

function applyWindyLayerVisibility(): void {
    const id = windyLayerId();
    if (id) {
        map.maplibreMap.setLayoutProperty(id, 'visibility', windyLayerHidden ? 'none' : 'visible');
    }
}

// Windy re-enables its layer on every params change and then emits tileLayerParamsChanged synchronously, so it's
// hidden again there, before the next frame.
export function setWindyLayerHidden(hidden: boolean): void {
    if (hidden === windyLayerHidden) {
        return;
    }
    windyLayerHidden = hidden;
    if (hidden) {
        bcast.on('tileLayerParamsChanged', applyWindyLayerVisibility);
    } else {
        bcast.off('tileLayerParamsChanged', applyWindyLayerVisibility);
    }
    applyWindyLayerVisibility();
    log(hidden ? `Windy layer '${windyLayerId()}' hidden` : 'Windy layer shown');
}

// --- All ---

export function restoreAll(): void {
    setInterpolatorOverride(null);
    setPickerDecorator(null);
    setRangeControl(false);
    setWindyLayerHidden(false);
}

export type HooksStatus = {
    interpolator: boolean; // installed and still in place
    picker: boolean;
    rangeControl: boolean;
    windyLayerHidden: boolean;
    windyLayerId: string | null;
    userControl: string | null;
};

export function getHooksStatus(): HooksStatus {
    const id = windyLayerId();
    return {
        interpolator: installedInterpolator !== null && renderers.tileLayer.interpolator === installedInterpolator,
        picker: installedPickerHTML !== null && overlays.temp.createPickerHTML === installedPickerHTML,
        rangeControl: rangeControl && renderers.tileLayer.userControl === 'accumulations',
        windyLayerHidden: !!id && map.maplibreMap.getLayoutProperty(id, 'visibility') === 'none',
        windyLayerId: id ?? null,
        userControl: renderers.tileLayer.userControl ? String(renderers.tileLayer.userControl) : null,
    };
}

function checkPatches(): void {
    const status = getHooksStatus();
    const lost = [
        installedInterpolator && !status.interpolator && 'interpolator override',
        installedPickerHTML && !status.picker && 'picker decorator',
        rangeControl && !status.rangeControl && 'range control',
        windyLayerHidden && !status.windyLayerHidden && 'hidden Windy layer',
    ].filter(Boolean);
    if (lost.length) {
        console.error(`[alpine-planner] windyHooks: Windy undid our ${lost.join(', ')}`, status);
    }
}

// Debug mode: logs every patch and checks after each redrawFinished that they're all still in place.
export function setHooksDebug(on: boolean): void {
    if (on === debug) {
        return;
    }
    debug = on;
    if (on) {
        bcast.on('redrawFinished', checkPatches);
    } else {
        bcast.off('redrawFinished', checkPatches);
    }
}

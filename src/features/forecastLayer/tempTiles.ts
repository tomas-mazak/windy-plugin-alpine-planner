// Windy's 2 m temperature tiles: the render params Windy's TileLayer uses (product, run, step, URL, data quality), its
// data zoom, and the URLs of the other steps (docs/forecast-layer-algorithm.md §1).

import { addTileAuthParams } from '@windy/authParams';
import bcast from '@windy/broadcast';
import { createFullRenderingParams, getDataZoom } from '@windy/renderUtils';
import store from '@windy/store';

import type { FullRenderParameters } from '@windy/interfaces';

export type TempParams = FullRenderParameters;

const isTempSurface = (params: TempParams): boolean => params.layer === 'temp' && params.level === 'surface';

// Windy's temp render params now, as its TileLayer builds them; null without a calendar or run.
async function currentTempParams(): Promise<TempParams | null> {
    const weather = {
        acRange: Math.floor(store.get('acRange')),
        levelsRange: store.get('levelsRange'),
        isolinesType: store.get('isolinesType'),
        isolinesOn: store.get('isolinesOn'),
        overlay: 'temp' as const,
        level: 'surface' as const,
        product: store.get('product'),
    };
    try {
        return await createFullRenderingParams('temp', weather, store.get('timestamp'));
    } catch (err) {
        console.warn('[alpine-planner] temp render params unavailable', err);
        return null;
    }
}

// Calls onChange with Windy's temp params now, then with every params object Windy's TileLayer renders temp at the
// surface with (tileLayerParamsChanged: timeline, model, new run). Returns the unsubscribe function.
export function watchTempParams(onChange: (params: TempParams) => void): () => void {
    let latest = 0;
    const onParams = (params: TempParams): void => {
        if (isTempSurface(params)) {
            latest++;
            onChange(params);
        }
    };
    bcast.on('tileLayerParamsChanged', onParams);
    const initial = latest;
    void currentTempParams().then(params => {
        if (params && latest === initial) {
            onChange(params); // unless Windy's own params arrived first
        }
    });
    return () => {
        latest = -1;
        bcast.off('tileLayerParamsChanged', onParams);
    };
}

// The data tile zoom Windy uses for a render tile zoom.
export const dataZoom = (params: TempParams, z: number): number => Math.min(getDataZoom(params, z), z);

// Windy's data zoom for the picker's render zoom, round(clamp(MapLibre zoom, 2, 10)) + 1, as Windy's picker
// interpolates.
export const pickerDataZoom = (params: TempParams, maplibreZoom: number): number =>
    dataZoom(params, Math.round(Math.min(Math.max(maplibreZoom, 2), 10)) + 1);

// The lossless PNG of one field (default temp-surface; temp-<L>, gh-<L> for the correction) at another step of
// Windy's temp tiles: Windy's URL with the step path segment (calendar.ts2path) and the file name replaced, .jpg →
// .png, plus the auth params.
// Algorithm: docs/forecast-layer-algorithm.md §1.2, §7.2
export const stepTileUrl = (params: TempParams, path: string, z: number, x: number, y: number, file = 'temp-surface') =>
    addTileAuthParams(
        params.fullPath
            .replace(`/${params.path}/`, `/${path}/`)
            .replace(/\/[^/]+\.jpg(\?|$)/, `/${file}.png$1`)
            .replace('<z>', String(z))
            .replace('<x>', String(x))
            .replace('<y>', String(y)),
    );

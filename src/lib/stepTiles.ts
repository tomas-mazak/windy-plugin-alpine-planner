// Step tiles: Windy's lossless PNG of one field for one step and data tile (the forecast layer: temp-surface, with the
// correction also temp-<L> and gh-<L>, docs/forecast-layer-algorithm.md §1.2; the isotherm mask's window: deg0-surface,
// with the correction the same fields, docs/freezing-mask-algorithm.md §6.3), fetched by one request scheduler shared by
// both features and kept as raw bytes in a session LRU. A window change then re-folds from memory and fetches only the
// missing steps.

import { map } from '@windy/map';
import { isMobileOrTablet } from '@windy/rootScope';

import { mercatorX, mercatorY } from './mercator';
import { fetchWindyTile, type WindyTileHeader } from './windyTile';

// Bytes as served (T = min + step · byte), and the nodata mask (≥ 128 = nodata), null when the tile has no nodata.
export type StepTile = { header: WindyTileHeader; grid: Uint8Array; mask: Uint8Array | null };

// One user of a request: the data tile and step it's for (for the priority), and its callbacks.
export type StepTileUser = {
    z: number;
    x: number;
    y: number;
    step: number; // index in the window's steps
    urgent?: boolean; // the picker waits for it
    onLoad: (tile: StepTile) => void;
    onFail: () => void;
};

const MAX_IN_FLIGHT = 8;
// A byte budget: step tiles are ≈ 70 kB (bytes, plus the mask only where there's nodata), and with the lapse rate
// correction a step needs the pressure levels too.
const CACHE_BYTES = (isMobileOrTablet ? 64 : 160) * 1e6;
const ATTEMPTS = 2; // a failed request is retried once

type Request = { url: string; users: Set<StepTileUser>; abort: AbortController | null; attempts: number };

const cache = new Map<string, StepTile>();
let cacheBytes = 0;
const requests = new Map<string, Request>(); // queued (abort null) and in flight
let inFlight = 0;
const counts = { done: 0, failed: 0, aborted: 0 };
const logged = new Set<string>();

const tileBytes = (tile: StepTile): number => tile.grid.length + (tile.mask?.length ?? 0);

function cacheTile(url: string, tile: StepTile): void {
    const old = cache.get(url);
    if (old) {
        cache.delete(url);
        cacheBytes -= tileBytes(old);
    }
    cache.set(url, tile);
    cacheBytes += tileBytes(tile);
    while (cacheBytes > CACHE_BYTES && cache.size > 1) {
        const [oldestUrl, oldest] = cache.entries().next().value!;
        cache.delete(oldestUrl);
        cacheBytes -= tileBytes(oldest);
    }
}

// A cached step tile (most recently used from now on), or undefined.
export function cachedStepTile(url: string): StepTile | undefined {
    const tile = cache.get(url);
    if (tile) {
        cache.delete(url);
        cache.set(url, tile);
    }
    return tile;
}

// Requests a step tile; returns the cancel function. A cached tile is delivered at once. Users of the same URL share
// one fetch, which is aborted when its last user cancels; a fetch someone still wants keeps going.
export function requestStepTile(url: string, user: StepTileUser): () => void {
    const tile = cachedStepTile(url);
    if (tile) {
        user.onLoad(tile);
        return () => {};
    }
    let request = requests.get(url);
    if (!request) {
        request = { url, users: new Set(), abort: null, attempts: 0 };
        requests.set(url, request);
    }
    request.users.add(user);
    pump();
    return () => {
        const r = requests.get(url);
        if (!r || !r.users.delete(user) || r.users.size > 0) {
            return;
        }
        requests.delete(url);
        if (r.abort) {
            r.abort.abort(); // start() frees the slot
            counts.aborted++;
        }
    };
}

// The same as a promise for one user; null if it failed or `signal` aborted.
export function loadStepTile(url: string, user: Omit<StepTileUser, 'onLoad' | 'onFail'>, signal?: AbortSignal) {
    return new Promise<StepTile | null>(resolve => {
        if (signal?.aborted) {
            resolve(null);
            return;
        }
        const cancel = requestStepTile(url, { ...user, onLoad: resolve, onFail: () => resolve(null) });
        signal?.addEventListener('abort', () => {
            cancel();
            resolve(null);
        });
    });
}

// Lower runs first: the picker's requests, then the data tiles nearest the view centre, then the steps in time order.
function priority({ users }: Request, centreX: number, centreY: number): number {
    let best = Infinity;
    for (const { z, x, y, step, urgent } of users) {
        const n = 2 ** z;
        const dx = ((((x + 0.5) / n - centreX + 1.5) % 1) - 0.5) * n; // tiles, across the antimeridian too
        const dy = ((y + 0.5) / n - centreY) * n;
        best = Math.min(best, urgent ? -1 : Math.floor(Math.hypot(dx, dy)) * 10000 + step);
    }
    return best;
}

function pump(): void {
    while (inFlight < MAX_IN_FLIGHT) {
        const centre = map.maplibreMap.getCenter();
        const [cx, cy] = [mercatorX(centre.lng), mercatorY(centre.lat)];
        let next: Request | null = null;
        let best = Infinity;
        for (const request of requests.values()) {
            const p = request.abort ? Infinity : priority(request, cx, cy);
            if (p < best) {
                best = p;
                next = request;
            }
        }
        if (!next) {
            return;
        }
        void start(next);
    }
}

async function start(request: Request): Promise<void> {
    inFlight++;
    request.attempts++;
    const abort = new AbortController();
    request.abort = abort;
    try {
        const { header, grid, mask } = await fetchWindyTile(request.url, 'png', abort.signal);
        const tile: StepTile = { header, grid, mask: mask.some(v => v >= 128) ? mask : null };
        cacheTile(request.url, tile);
        counts.done++;
        if (requests.get(request.url) === request) {
            requests.delete(request.url);
            request.users.forEach(user => user.onLoad(tile));
        }
    } catch (err) {
        if (!abort.signal.aborted && requests.get(request.url) === request) {
            if (request.attempts < ATTEMPTS) {
                request.abort = null; // back in the queue
            } else {
                requests.delete(request.url);
                counts.failed++;
                if (!logged.has(request.url)) {
                    logged.add(request.url);
                    console.warn(`[alpine-planner] step tile failed twice, folded without it: ${request.url}`, err);
                }
                request.users.forEach(user => user.onFail());
            }
        }
    } finally {
        inFlight--;
        pump();
    }
}

export type StepTileStats = {
    inFlight: number;
    queued: number;
    done: number;
    failed: number;
    aborted: number;
    cached: number;
    cachedMB: number;
    budgetMB: number;
};

export const stepTileStats = (): StepTileStats => ({
    inFlight,
    queued: [...requests.values()].filter(r => !r.abort).length,
    ...counts,
    cached: cache.size,
    cachedMB: cacheBytes / 1e6,
    budgetMB: CACHE_BYTES / 1e6,
});

// A read-only interface for the end-to-end tests (e2e/), not for users: window.__alpinePlanner, exposed only when
// localStorage['windy-plugin-alpine-planner:test'] === '1' (separate from the debug flag, so the debug window stays
// closed), installed when the plugin opens and removed when it closes. Tests read data through it and drive the UI
// like a user; there are no setters.

import renderers from '@windy/renderers';

import config from '../pluginConfig';
import { getHooksStatus, type HooksStatus } from '../features/forecastLayer/windyHooks';

import type { PluginState, Tool } from './pluginState';

export const TEST_KEY = 'windy-plugin-alpine-planner:test';

// What a panel shows in its status lines, and whether its layer is still loading.
export type ToolStatus = { lines: string[]; loading: boolean; failed: number };

export type AlpinePlannerTestApi = {
    version: string;
    state(): {
        tool: Tool;
        temp: PluginState['activity']['temp'];
        mask: Omit<PluginState['activity']['mask'], 'isoWindow'> & { window: PluginState['activity']['mask']['isoWindow'] };
        values: PluginState['values'];
    };
    status(): {
        temp: string[];
        mask: string[];
        loading: { temp: boolean; mask: boolean };
        failed: { temp: number; mask: number };
    };
    hooks(): HooksStatus & { interpolatorIsWindys: boolean; userControl: string | null };
    boxSize(): { width: number; height: number };
};

type TestWindow = Window & { __alpinePlanner?: AlpinePlannerTestApi };

const idle = (): ToolStatus => ({ lines: [], loading: false, failed: 0 });
const statuses: Record<Tool, ToolStatus> = { temp: idle(), mask: idle() };

// The panels report every change of their status here (one assignment, whether the test API is on or not).
export function reportStatus(tool: Tool, status: ToolStatus): void {
    statuses[tool] = status;
}

function enabled(): boolean {
    try {
        return localStorage.getItem(TEST_KEY) === '1';
    } catch {
        return false;
    }
}

// On plugin open, before the panels mount (so Windy's interpolator is captured unpatched). Returns the removal.
export function installTestApi(getState: () => PluginState, getRoot: () => HTMLElement | undefined): () => void {
    if (!enabled()) {
        return () => {};
    }
    const windysInterpolator = renderers.tileLayer.interpolator;
    const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

    const api: AlpinePlannerTestApi = {
        version: config.version,
        state() {
            const { values, activity } = getState();
            const { isoWindow, ...mask } = activity.mask;
            return copy({ tool: activity.tool, temp: activity.temp, mask: { ...mask, window: isoWindow }, values });
        },
        status() {
            const { temp, mask } = statuses;
            return copy({
                temp: temp.lines,
                mask: mask.lines,
                loading: { temp: temp.loading, mask: mask.loading },
                failed: { temp: temp.failed, mask: mask.failed },
            });
        },
        hooks() {
            return { ...getHooksStatus(), interpolatorIsWindys: renderers.tileLayer.interpolator === windysInterpolator };
        },
        // Windy's box around the plugin (desktop: the embedded box; mobile: the small bottom pane).
        boxSize() {
            const root = getRoot();
            const box = document.getElementById(`plugin-${config.name}`) ?? root?.parentElement ?? root;
            const rect = box?.getBoundingClientRect();
            return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
        },
    };

    const w = window as TestWindow;
    w.__alpinePlanner = api;
    return () => {
        if (w.__alpinePlanner === api) {
            delete w.__alpinePlanner;
        }
    };
}

// The plugin's remembered state: one object under one localStorage key. The user's values (elevation range, offset)
// are always kept; the activity (tool, modes, correction, isotherm window) only if saved less than STATE_FRESH_MS ago,
// otherwise the plugin opens in its defaults. Every field is validated on its own: an invalid one falls back to its
// default without discarding the rest. Pure apart from loadState / saveState; unit-tested (pluginState.test.ts).

import {
    DEFAULT_FROM,
    DEFAULT_OFFSET,
    DEFAULT_TO,
    ELEVATION_STEP,
    MAX_ELEVATION,
    MAX_OFFSET,
    MIN_ELEVATION,
    MIN_OFFSET,
    MIN_RANGE_GAP,
    OFFSET_STEP,
} from '../features/elevationMask/constants.ts';

import type { IsoWindow } from '../features/elevationMask/isoWindow.ts';

export const STATE_KEY = 'windy-plugin-alpine-planner:state';
export const STATE_FRESH_MS = 60 * 60 * 1000;
// Written by earlier versions (the mask settings, the tool tab): not migrated, removed once the new state is saved.
const OLD_KEYS = ['windy-plugin-alpine-planner:v1', 'windy-plugin-alpine-planner:tool'];

const TOOLS = ['temp', 'mask'] as const;
const TEMP_MODES = ['instant', 'min', 'max'] as const;
const MASK_MODES = ['off', 'elevation', 'freezing'] as const;
const ISO_MODES = ['instant', 'min', 'max', 'both'] as const;

export type Tool = (typeof TOOLS)[number];

export type PluginState = {
    values: { from: number; to: number; offset: number };
    activity: {
        tool: Tool;
        temp: { mode: (typeof TEMP_MODES)[number]; correction: boolean };
        mask: {
            mode: (typeof MASK_MODES)[number];
            isoMode: (typeof ISO_MODES)[number];
            isoCorrection: boolean;
            isoWindow: IsoWindow | null; // with `clipped`: the free forecast note survives a restore
        };
    };
};

export const defaultActivity = (): PluginState['activity'] => ({
    tool: 'temp',
    temp: { mode: 'instant', correction: false },
    mask: { mode: 'off', isoMode: 'instant', isoCorrection: false, isoWindow: null },
});

// Any object's fields, or none.
type Fields = Record<string, unknown>;
const fields = (v: unknown): Fields => (v !== null && typeof v === 'object' ? (v as Fields) : {});

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(v as T) ? (v as T) : fallback;

const bool = (v: unknown): boolean => (typeof v === 'boolean' ? v : false);

// A number within [min, max], rounded to the step; otherwise null.
const stepped = (v: unknown, min: number, max: number, step: number): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.round(v / step) * step : null;

function restoreValues(raw: unknown): PluginState['values'] {
    const v = fields(raw);
    const from = stepped(v.from, MIN_ELEVATION, MAX_ELEVATION - MIN_RANGE_GAP, ELEVATION_STEP) ?? DEFAULT_FROM;
    const to = stepped(v.to, MIN_ELEVATION + MIN_RANGE_GAP, MAX_ELEVATION, ELEVATION_STEP) ?? DEFAULT_TO;
    // Two valid bounds that break the gap rule together: the default range
    const range = to - from >= MIN_RANGE_GAP ? { from, to } : { from: DEFAULT_FROM, to: DEFAULT_TO };
    return { ...range, offset: stepped(v.offset, MIN_OFFSET, MAX_OFFSET, OFFSET_STEP) ?? DEFAULT_OFFSET };
}

function restoreWindow(raw: unknown): IsoWindow | null {
    const { start, end, clipped } = fields(raw);
    return typeof start === 'number' && typeof end === 'number' && Number.isFinite(start) && Number.isFinite(end) && end >= start
        ? { start, end, clipped: bool(clipped) }
        : null;
}

function restoreActivity(raw: unknown): PluginState['activity'] {
    const a = fields(raw);
    const temp = fields(a.temp);
    const mask = fields(a.mask);
    return {
        tool: oneOf(a.tool, TOOLS, 'temp'),
        temp: { mode: oneOf(temp.mode, TEMP_MODES, 'instant'), correction: bool(temp.correction) },
        mask: {
            mode: oneOf(mask.mode, MASK_MODES, 'off'),
            isoMode: oneOf(mask.isoMode, ISO_MODES, 'instant'),
            isoCorrection: bool(mask.isoCorrection),
            isoWindow: restoreWindow(mask.isoWindow),
        },
    };
}

// The stored text (null: nothing stored) → the state to open with.
export function restoreState(raw: string | null, now: number): PluginState {
    let parsed: unknown = null;
    try {
        parsed = raw === null ? null : JSON.parse(raw);
    } catch {
        // corrupt: the defaults
    }
    const s = fields(parsed);
    if (s.v !== 1) {
        return { values: restoreValues(null), activity: defaultActivity() };
    }
    const age = typeof s.savedAt === 'number' ? now - s.savedAt : NaN;
    const fresh = age >= 0 && age < STATE_FRESH_MS; // a savedAt in the future is stale
    return { values: restoreValues(s.values), activity: fresh ? restoreActivity(s.activity) : defaultActivity() };
}

export const serializeState = ({ values, activity }: PluginState, now: number): string =>
    JSON.stringify({ v: 1, savedAt: now, values, activity });

// --- Storage: unavailable storage means the defaults and no saving, never an error ---

export function loadState(now: number): PluginState {
    let raw: string | null = null;
    try {
        raw = localStorage.getItem(STATE_KEY);
    } catch {
        // unavailable
    }
    return restoreState(raw, now);
}

export function saveState(state: PluginState, now: number): void {
    try {
        localStorage.setItem(STATE_KEY, serializeState(state, now));
        OLD_KEYS.forEach(key => localStorage.removeItem(key));
    } catch {
        // unavailable or full
    }
}

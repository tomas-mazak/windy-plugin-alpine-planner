<div class:touch={ isMobileOrTablet } bind:this={ root }>
    <div class="row">
        <PillSwitch items={ MODES } value={ mode } label="Mask mode" on:change={ e => setMode(e.detail) } />
    </div>

    <div class:unavailable={ maskUnavailable }>
        {#if mode === 'elevation'}
            <div class="row elevation">
                <NumberField text={ labels.from } value={ from } label="Lowest elevation" widths={ [50, 64] } disabled={ maskUnavailable }
                    on:commit={ e => commitElevation('from', e.detail) } />
                <RangeSlider min={ MIN_ELEVATION } max={ MAX_ELEVATION } step={ ELEVATION_STEP } gap={ MIN_RANGE_GAP }
                    {from} {to} labels={ ['Lowest elevation', 'Highest elevation'] } disabled={ maskUnavailable } on:change={ onSliderChange } />
                <NumberField text={ labels.to } value={ to } label="Highest elevation" widths={ [54, 68] } disabled={ maskUnavailable }
                    on:commit={ e => commitElevation('to', e.detail) } />
                <span class="unit">m</span>
            </div>
        {:else if mode === 'freezing'}
            <div class="row">
                <PillSwitch items={ ISO_MODES } value={ isoMode } label="Isotherm mode" on:change={ e => setIsoMode(e.detail) } />
                {#if isMobileOrTablet}
                    <!-- Mobile: the offset and the correction don't fit; they're in a popover above the pane. -->
                    <button type="button" class="settings" class:settings--set={ offset !== 0 || lapseCorrection } class:settings--open={ settingsOpen }
                        title="Offset and lapse rate correction" aria-expanded={ settingsOpen } bind:this={ settingsButton }
                        on:click={ toggleSettings }>{ offset === 0 ? '±0 m' : offsetLabel }{ lapseCorrection ? ' · corr.' : '' }</button>
                {/if}
            </div>
            {#if isoMode !== 'instant' && isoWindow && windowSteps.length}
                <div class="window-label">
                    <span>{ windowLabel(isoWindow.start, isoWindow.end, formatWindyTime) }</span>
                    <button type="button" class="reset" title="Reset the window to the timeline time" aria-label="Reset window"
                        disabled={ maskUnavailable } on:click={ resetWindow }>↺</button>
                </div>
                <RangeSlider --height="22px" min={ 0 } max={ windowSteps.length - 1 } step={ 1 } gap={ 0 }
                    from={ windowSteps.indexOf(isoWindow.start) } to={ windowSteps.indexOf(isoWindow.end) }
                    labels={ ['Window start', 'Window end'] } tick={ sliderPosition(windowSteps, timelineTs) }
                    disabled={ maskUnavailable } on:change={ onWindowSliderChange } />
            {/if}
            {#if !isMobileOrTablet}
                <div class="row offset">
                    <OffsetSlider min={ MIN_OFFSET } max={ MAX_OFFSET } step={ OFFSET_STEP } value={ offset }
                        disabled={ maskUnavailable } on:change={ e => applyOffset(e.detail) } />
                    <NumberField text={ offsetLabel } value={ offset } label="Offset" title="Offset" inputmode="text" widths={ [56, 76] }
                        disabled={ maskUnavailable } on:commit={ e => commitOffset(e.detail) } />
                    <Toggle checked={ lapseCorrection } disabled={ maskUnavailable } title="Lapse rate correction"
                        on:change={ onLapseCorrectionChange }>Lapse rate corr.</Toggle>
                </div>
            {:else if settingsOpen}
                <!-- On <body>, like the help modal. Keys and pointer events stop here: Windy's body handlers act on them. -->
                <div class="settings-popover dark-content" role="dialog" aria-label="Isotherm settings" style="bottom: { popoverBottom }px"
                    use:toBody bind:this={ popover } on:keydown|stopPropagation on:pointerdown|stopPropagation
                    on:mousedown|stopPropagation on:touchstart|stopPropagation on:click|stopPropagation>
                    <div class="settings-popover__header">
                        Isotherm settings
                        <button type="button" class="settings-popover__close" aria-label="Close" on:click={ () => (settingsOpen = false) }>×</button>
                    </div>
                    <div class="settings-popover__label">Offset</div>
                    <div class="settings-popover__row">
                        <OffsetSlider min={ MIN_OFFSET } max={ MAX_OFFSET } step={ OFFSET_STEP } value={ offset }
                            disabled={ maskUnavailable } on:change={ e => applyOffset(e.detail) } />
                        <NumberField text={ offsetLabel } value={ offset } label="Offset" inputmode="text" widths={ [56, 76] }
                            disabled={ maskUnavailable } on:commit={ e => commitOffset(e.detail) } />
                    </div>
                    <Toggle checked={ lapseCorrection } disabled={ maskUnavailable } on:change={ onLapseCorrectionChange }>
                        Lapse rate correction
                    </Toggle>
                </div>
            {/if}
        {/if}
    </div>

    <StatusLines lines={ statusLines } />

    {#if debugEnabled}
        <!-- A floating window on the page, not in the panel: the panel's bottom is under Windy's legend and controls. -->
        <div class="debug-float" use:toBody>
            <button class="debug-float__header size-xs" on:click={ () => (debugCollapsed = !debugCollapsed) }>
                Alpine planner debug { debugCollapsed ? '▸' : '▾' }
            </button>
            <div class="debug-float__content" class:hidden={ debugCollapsed }>
            <div class="rounded-box rounded-box--with-border mt-10">
                <div class="size-xxs"><b>Debug</b></div>
                <div class="size-xxs">tileZ { debugCounts.tileZ ?? '-' }, map zoom { debugCounts.mapZoom?.toFixed(2) ?? '-' }</div>
                <div class="size-xxs">cached { debugCounts.cached }, pending { debugCounts.pending }, failed { debugCounts.failed }</div>
                <div class="size-xxs">renders { debugCounts.renders }, bucket { debugCounts.bucket ?? '-' }</div>
                <div class="size-xxs">deg0 { debugCounts.deg0Key ?? '-' }, z{ debugCounts.deg0Z ?? '-' }{ debugCounts.deg0Previous ? ' (+ previous)' : '' }, terrain aref { debugCounts.aref ?? '-' }</div>
                <div class="size-xxs">deg0 cached { debugCounts.deg0Cached }, pending { debugCounts.deg0Pending }, failed { debugCounts.deg0Failed }</div>
                <div class="size-xxs">correction pending { debugCounts.correctionPending }, failed fields { debugCounts.correctionFailed }, last recompute { debugCounts.recomputeMs?.toFixed(1) ?? '-' } ms</div>
                {#if mode === 'freezing' && isoMode !== 'instant'}
                    <div class="size-xxs">
                        window { isoMode }: { windowCtx ? `${ windowCtx.selection.steps.length } steps ${ formatWindyTime(windowCtx.selection.steps[0]) } … ${ formatWindyTime(windowCtx.selection.steps[windowCtx.selection.steps.length - 1]) }, spacing ${ windowCtx.selection.spacingH.join(', ') || '-' } h` : '-' };
                        { isoWindow?.clipped ? 'clipped' : 'not clipped' }
                    </div>
                    {#if debugCounts.window}
                        {@const w = debugCounts.window}
                        <div class="size-xxs">
                            fold: tiles { w.complete } / { w.tiles } complete, steps { w.loaded } / { w.needed }, failed { w.failed };
                            window steps failed { w.failedSteps }, of them uncorrected (T2m failed) { w.fellBack };
                            last upload { w.lastUploadAt !== null ? `${ ((now - w.lastUploadAt) / 1000).toFixed(1) } s ago` : '-' }
                        </div>
                    {/if}
                {/if}
                <div class="size-xxs">
                    step tiles (shared): in flight { requests.inFlight }, queued { requests.queued }, done { requests.done }, failed { requests.failed },
                    aborted { requests.aborted }; cache { requests.cached } ({ requests.cachedMB.toFixed(1) } / { requests.budgetMB } MB)
                </div>
                <label class="size-xxs"><input type="checkbox" bind:checked={ debugRaw } on:change={ onDebugOptionsChange } /> Raw elevation mode</label>
                <label class="size-xxs"><input type="checkbox" bind:checked={ debugBorders } on:change={ onDebugOptionsChange } /> Tile borders</label>
                <div class="size-xxs mt-5">
                    {#if cursorSample}
                        z{ cursorSample.tileZ }/{ cursorSample.x }/{ cursorSample.y } row/col { cursorSample.row }/{ cursorSample.col } -- raw v={ cursorSample.v } -- h={ cursorSample.h.toFixed(1) }m
                        {#if cursorSample.deg0?.nodata}
                            -- deg0 no data
                        {:else if cursorSample.deg0}
                            {@const d = cursorSample.deg0}
                            <br />deg0={ d.deg0.toFixed(0) }m, terrain={ d.terrain.toFixed(0) }m, correction { d.correction }
                            {#if d.t2mC !== null}
                                <br />T2m={ d.t2mC.toFixed(1) }°C;
                                {#each d.profile as p}
                                    <span class:ignored={ p.ignored }>{ p.level } { p.gh.toFixed(0) }m { p.tempC.toFixed(1) }°C</span>;
                                {/each}
                                {#if !Number.isNaN(d.delta)}
                                    <br />below={ d.below ? `${ d.below.level } ${ d.below.gh.toFixed(0) }m ${ d.below.tempC.toFixed(1) }°C` : '(no level)' },
                                    L0={ d.l0 ? `${ d.l0.level } ${ d.l0.gh.toFixed(0) }m ${ d.l0.tempC.toFixed(1) }°C` : '(no level)' },
                                    T_free(z_s)={ d.tFree.toFixed(1) }°C, Δ={ d.delta.toFixed(1) } K, d0={ d.d0.toFixed(0) }m;
                                    cursor d={ d.d.toFixed(0) }m, w={ d.w.toFixed(2) }
                                {/if}
                            {/if}
                            <br />{ d.branch } -- F={ d.F.toFixed(0) }m (cursor { d.Fpx.toFixed(0) }m), F+offset={ (d.Fpx + offset).toFixed(0) }m
                        {/if}
                        {#if cursorSample.window?.nodata}
                            -- window no data
                        {:else if cursorSample.window}
                            {#each windowReadout(cursorSample.window, isoMode, offset) as line}
                                <br />{ line }
                            {/each}
                        {/if}
                    {:else}
                        hover the map for a reading
                    {/if}
                </div>
            </div>
            <ForecastLayerReadouts />
            </div>
        </div>
    {/if}
</div>

<script lang="ts">
    import { map } from '@windy/map';
    import { isMobileOrTablet } from '@windy/rootScope';
    import store from '@windy/store';
    import { onDestroy, onMount } from 'svelte';

    import { stepTileStats, type StepTileStats } from '../../lib/stepTiles';
    import { reportStatus } from '../../lib/testApi';
    import { formatWindyTime } from '../../lib/windyTime';

    import {
        ELEVATION_STEP,
        LAYER_ID,
        MAX_ELEVATION,
        MAX_OFFSET,
        MIN_ELEVATION,
        MIN_OFFSET,
        MIN_RANGE_GAP,
        OFFSET_STEP,
        WINDOW_DEBOUNCE_MS,
    } from './constants';
    import {
        premiumLimit,
        watchDeg0Context,
        windowContext,
        type Deg0Context,
        type Deg0Model,
        type Deg0ModelOk,
        type Deg0WindowContext,
    } from './deg0';
    import { instantStatus, runText, windowLabel, windowStatus } from './isoStatus';
    import { allowedSteps, clipWindow, initialWindow, sliderPosition, type IsoWindow } from './isoWindow';
    import {
        bucketForZoom,
        createElevationMaskLayer,
        type CursorSample,
        type DebugCounts,
        type ElevationMaskLayer,
        type IsoMode,
        type MaskMode,
        type WindowSample,
    } from './layer';
    import type { WindowStats } from './windowTiles';
    import ForecastLayerReadouts from '../forecastLayer/ForecastLayerReadouts.svelte';
    import NumberField from '../../ui/NumberField.svelte';
    import PillSwitch from '../../ui/PillSwitch.svelte';
    import StatusLines, { type StatusLine } from '../../ui/StatusLines.svelte';
    import Toggle from '../../ui/Toggle.svelte';
    import OffsetSlider from './OffsetSlider.svelte';
    import RangeSlider from './RangeSlider.svelte';

    const DEBUG_KEY = 'windy-plugin-alpine-planner:debug';

    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
    const roundToStep = (v: number) => Math.round(v / ELEVATION_STEP) * ELEVATION_STEP;

    type Mode = 'off' | MaskMode;
    const MODES: { id: Mode; label: string }[] = [
        { id: 'off', label: 'Off' },
        { id: 'elevation', label: 'Elevation' },
        { id: 'freezing', label: 'Isotherm' },
    ];
    const ISO_MODES: { id: IsoMode; label: string }[] = [
        { id: 'instant', label: 'Instant' },
        { id: 'min', label: 'Min' },
        { id: 'max', label: 'Max' },
        { id: 'both', label: 'Both' },
    ];

    let debugEnabled = false;
    let debugCollapsed = false;

    // Moves the element to <body>, so position: fixed is relative to the page whatever Windy's plugin containers do.
    function toBody(node: HTMLElement): { destroy: () => void } {
        document.body.appendChild(node);
        return { destroy: () => node.remove() };
    }
    try {
        debugEnabled = localStorage.getItem(DEBUG_KEY) === '1';
    } catch {
        // ignore
    }

    // Remembered by the plugin (src/lib/pluginState.ts): the initial values in, every change out (bound).
    export let mode: Mode; // also read by the plugin: the help opens on the current mode's tab
    export let from: number;
    export let to: number;
    export let offset: number;
    export let lapseCorrection: boolean;
    export let isoMode: IsoMode;
    // Min / Max / Both: the mask's own window (docs/freezing-mask-algorithm.md §6.2). A remembered one is fitted to the
    // model's current steps on open; without one it's initialised from Windy's timeline, as when leaving Instant. Then
    // independent of the timeline.
    export let isoWindow: IsoWindow | null;
    export let summary = ''; // the tab's summary
    export let active = true; // the Mask tab is shown

    let layer: ElevationMaskLayer | null = null;
    let hiddenForGlobe = false;
    let deg0Model: Deg0Model | null = null;
    let deg0Ctx: Deg0Context | null = null; // Instant
    let stopDeg0Watch: (() => void) | null = null;

    let windowModelKey: string | null = null; // the model, run and premium status the window was fitted to
    let windowTimer: ReturnType<typeof setTimeout> | undefined;
    let windowStats: WindowStats | null = null;
    let instantLoading = false;
    let timelineTs: number = store.get('timestamp'); // the timeline tick on the window slider
    let requests: StepTileStats = stepTileStats();
    let now = performance.now();

    let debugRaw = false;
    let debugBorders = false;
    let debugCounts: DebugCounts = {
        tileZ: null,
        mapZoom: null,
        cached: 0,
        pending: 0,
        failed: 0,
        renders: 0,
        bucket: null,
        deg0Key: null,
        deg0Z: null,
        deg0Cached: 0,
        deg0Pending: 0,
        deg0Failed: 0,
        deg0Previous: false,
        aref: null,
        correctionPending: 0,
        correctionFailed: 0,
        recomputeMs: null,
        window: null,
    };
    let cursorSample: CursorSample | null = null;

    // The slider's steps: the mask model's, for free users up to the free forecast horizon.
    $: windowSteps = deg0Model?.ok ? allowedSteps(deg0Model.calendar.timestamps, premiumLimit(deg0Model)) : [];
    $: windowCtx = isoMode !== 'instant' && deg0Model?.ok && isoWindow ? windowContext(deg0Model, isoWindow) : null;

    // What the isotherm is based on (isoStatus.ts); the run's date is in the tooltip.
    function isoStatusLines(
        iso: IsoMode,
        model: Deg0Model | null,
        instant: Deg0Context | null,
        ctx: Deg0WindowContext | null,
        stats: WindowStats | null,
        loadingInstant: boolean,
    ): StatusLine[] {
        const withRun = (text: string, m: Deg0ModelOk): StatusLine => ({ text, title: `${text}\n${m.label}` });
        if (iso === 'instant') {
            if (!instant) {
                return [];
            }
            return instant.ok
                ? [withRun(instantStatus(runText(instant.model.name, instant.model.refTime), instant.timestamp, loadingInstant, formatWindyTime), instant.model)]
                : [{ text: instant.reason, error: true }];
        }
        if (!model || !model.ok) {
            return model ? [{ text: model.reason, error: true }] : [];
        }
        if (!ctx) {
            return [];
        }
        const loading = stats && stats.loaded + stats.failed < stats.needed ? stats : null;
        const freeEnd = isoWindow?.clipped ? model.calendar.premiumStart : null;
        const failed = stats?.failedSteps ?? 0;
        const [first, ...rest] = windowStatus(
            { run: runText(model.name, model.refTime), ...ctx.selection, loading, failed, freeEnd, mobile: isMobileOrTablet },
            formatWindyTime,
        );
        return [withRun(first, model), ...rest.map(text => ({ text }))];
    }

    $: statusLines = hiddenForGlobe
        ? [{ text: 'Hidden in 3D globe view' }]
        : mode === 'freezing'
          ? isoStatusLines(isoMode, deg0Model, deg0Ctx, windowCtx, windowStats, instantLoading)
          : [];

    // For the end-to-end tests (src/lib/testApi.ts). Isotherm Instant: until its context and tiles are in; a window:
    // until every step of its data tiles in view is loaded or failed.
    $: windowSettled = !!windowStats && windowStats.needed > 0 && windowStats.loaded + windowStats.failed >= windowStats.needed;
    $: reportStatus('mask', {
        lines: statusLines.map(l => l.text),
        loading: mode === 'freezing' && (isoMode === 'instant' ? !deg0Ctx || instantLoading : !windowSettled),
        failed: mode === 'freezing' && isoMode !== 'instant' ? (windowStats?.failedSteps ?? 0) : 0,
    });

    // Debug, at the cursor: F_min and F_max at the nearest node with their steps' times, every step's F (– where not
    // cached), and F at the cursor as the shader uses it.
    function windowReadout(w: Extract<WindowSample, { nodata: false }>, iso: IsoMode, metres: number): string[] {
        let lo = -1;
        let hi = -1;
        w.F.forEach((f, s) => {
            if (!Number.isNaN(f)) {
                lo = lo < 0 || f < w.F[lo] ? s : lo;
                hi = hi < 0 || f > w.F[hi] ? s : hi;
            }
        });
        const at = (s: number): string => (s < 0 ? '–' : `${w.F[s].toFixed(0)}m (${formatWindyTime(w.steps[s])})`);
        const plus = (f: number): string => `${f.toFixed(0)}m + offset = ${(f + metres).toFixed(0)}m`;
        const used = iso === 'min' ? `F_min ${plus(w.FminPx)}` : iso === 'max' ? `F_max ${plus(w.FmaxPx)}` : `F_min ${plus(w.FminPx)}, F_max ${plus(w.FmaxPx)}`;
        return [
            `node: F_min=${at(lo)}, F_max=${at(hi)}; steps: ${w.F.map(f => (Number.isNaN(f) ? '–' : f.toFixed(0))).join(' ')}`,
            `cursor: ${used}`,
        ];
    }
    $: maskUnavailable = hiddenForGlobe;

    // "1,800–2,600", "0 °C · Both"; "! " when the isotherm can't be shown.
    $: isoError = mode === 'freezing' && (isoMode === 'instant' ? deg0Ctx?.ok === false : deg0Model?.ok === false);
    $: summary =
        (isoError ? '! ' : '') +
        (mode === 'off'
            ? 'Off'
            : mode === 'elevation'
              ? `${labels.from}–${labels.to}`
              : `0 °C · ${ISO_MODES.find(m => m.id === isoMode)!.label}`);

    // --- The numbers ---

    $: labels = { from: from.toLocaleString(), to: to.toLocaleString() + (to >= MAX_ELEVATION ? '+' : '') };
    // A proper minus sign (U+2212)
    $: offsetLabel = `${offset > 0 ? '+' : offset < 0 ? '\u2212' : ''}${Math.abs(offset)} m`;

    // A typed elevation: rounded to the step, clamped, and kept the minimum gap from the other bound.
    function commitElevation(which: 'from' | 'to', value: number): void {
        const rounded = clamp(roundToStep(value), MIN_ELEVATION, MAX_ELEVATION);
        if (which === 'from') {
            from = Math.min(rounded, to - MIN_RANGE_GAP);
        } else {
            to = Math.max(rounded, from + MIN_RANGE_GAP);
        }
        applyRange();
    }

    function commitOffset(value: number): void {
        applyOffset(clamp(Math.round(value / OFFSET_STEP) * OFFSET_STEP, MIN_OFFSET, MAX_OFFSET));
    }

    // --- Mobile: the isotherm settings popover ---

    let root: HTMLDivElement;
    let settingsButton: HTMLButtonElement | undefined;
    let popover: HTMLDivElement | undefined;
    let settingsOpen = false;
    let popoverBottom = 0;

    // Closed with the Isotherm controls (another mode or tab).
    $: if (!active || mode !== 'freezing') {
        settingsOpen = false;
    }

    function toggleSettings(): void {
        settingsOpen = !settingsOpen;
    }

    // Above Windy's pane: from the pane's top edge (the viewport bottom is the reference of position: fixed). Kept
    // there while open: the pane grows or shrinks with the status lines, and the window changes on rotation.
    let paneObserver: ResizeObserver | null = null;

    function placePopover(): void {
        const pane = root.closest('.plugin-mobile-bottom-small') ?? root;
        popoverBottom = window.innerHeight - pane.getBoundingClientRect().top + 8;
    }

    function watchPane(): void {
        placePopover();
        if (!paneObserver) {
            paneObserver = new ResizeObserver(placePopover);
            paneObserver.observe(root.closest('.plugin-mobile-bottom-small') ?? root);
            window.addEventListener('resize', placePopover);
        }
    }

    function unwatchPane(): void {
        paneObserver?.disconnect();
        paneObserver = null;
        window.removeEventListener('resize', placePopover);
    }

    // A tap outside the popover closes it (capture phase: before anything on the page can stop it). The button
    // toggles on its own.
    function onOutsidePointer(e: PointerEvent): void {
        const target = e.target as Node;
        if (!popover?.contains(target) && !settingsButton?.contains(target)) {
            settingsOpen = false;
        }
    }

    $: if (settingsOpen) {
        document.addEventListener('pointerdown', onOutsidePointer, true);
        watchPane();
    } else {
        document.removeEventListener('pointerdown', onOutsidePointer, true);
        unwatchPane();
    }

    // --- Layer lifecycle ---

    function enableLayer(m: MaskMode): void {
        layer = createElevationMaskLayer({
            id: LAYER_ID,
            initialFrom: from,
            initialTo: to,
        });
        layer.setMode(m);
        layer.setOffset(offset);
        layer.setLapseCorrection(lapseCorrection);
        pushWindow();
        layer.setIsoMode(isoMode);
        map.addMapLibreOrderedLayerToBucket(layer, bucketForZoom(map.maplibreMap.getZoom()));
    }

    function disableLayer(): void {
        if (layer) {
            map.removeMapLibreOrderedLayer(LAYER_ID);
            layer = null;
        }
    }

    // The deg0 context is resolved only in freezing mode.
    function syncDeg0Watch(): void {
        if (mode === 'freezing' && !stopDeg0Watch) {
            stopDeg0Watch = watchDeg0Context((model, ctx) => {
                deg0Model = model;
                deg0Ctx = ctx;
                layer?.setDeg0Context(ctx);
                fitWindow();
                pushWindow();
            });
        } else if (mode !== 'freezing' && stopDeg0Watch) {
            stopDeg0Watch();
            stopDeg0Watch = null;
            deg0Model = null;
            deg0Ctx = null;
        }
    }

    // Fits the window to the model: initialised from the timeline time when there's none, clipped (or re-initialised
    // if it no longer fits) on a new run, another model or a premium change.
    function fitWindow(): void {
        if (isoMode === 'instant' || !deg0Model?.ok) {
            return;
        }
        const key = `${deg0Model.key}/${deg0Model.premium}`;
        if (isoWindow && key === windowModelKey) {
            return;
        }
        const { timestamps } = deg0Model.calendar;
        const limit = premiumLimit(deg0Model);
        isoWindow =
            (isoWindow && clipWindow(isoWindow, timestamps, limit)) ?? initialWindow(timestamps, store.get('timestamp'), limit);
        windowModelKey = key;
    }

    // The window's steps to the layer (a new fold when they changed).
    function pushWindow(): void {
        clearTimeout(windowTimer);
        layer?.setWindowContext(isoMode !== 'instant' && deg0Model?.ok && isoWindow ? windowContext(deg0Model, isoWindow) : null);
    }

    function setIsoMode(next: IsoMode): void {
        if (next === isoMode) {
            return;
        }
        if (isoMode === 'instant') {
            isoWindow = null; // a new window from the timeline time
        }
        isoMode = next;
        fitWindow();
        pushWindow(); // first, so the layer doesn't fold a stale window
        layer?.setIsoMode(isoMode);
    }

    // ↺: a new window from the timeline time, as on open.
    function resetWindow(): void {
        isoWindow = null;
        fitWindow();
        pushWindow();
    }

    // Dragging: the handle times follow at once, the fold once the handles settle.
    function onWindowSliderChange(e: CustomEvent<{ from: number; to: number }>): void {
        isoWindow = { start: windowSteps[e.detail.from], end: windowSteps[e.detail.to], clipped: false };
        clearTimeout(windowTimer);
        windowTimer = setTimeout(pushWindow, WINDOW_DEBOUNCE_MS);
    }

    function applyMode(): void {
        if (mode === 'off') {
            disableLayer();
        } else if (layer) {
            layer.setMode(mode);
        } else {
            enableLayer(mode);
        }
        syncDeg0Watch();
    }

    function setMode(next: Mode): void {
        if (next === mode) {
            return;
        }
        mode = next;
        applyMode();
    }

    function onSliderChange(e: CustomEvent<{ from: number; to: number }>): void {
        ({ from, to } = e.detail);
        applyRange();
    }

    function applyRange(): void {
        layer?.setRange(from, to);
    }

    function onLapseCorrectionChange(e: CustomEvent<boolean>): void {
        lapseCorrection = e.detail;
        layer?.setLapseCorrection(lapseCorrection);
    }

    function applyOffset(value: number): void {
        offset = value;
        layer?.setOffset(offset);
    }

    function onDebugOptionsChange(): void {
        layer?.setDebugOptions({ raw: debugRaw, borders: debugBorders });
    }

    // Polls the layer's globe-hidden flag (and the debug counters): render() may not fire to tell us.
    let statusInterval: ReturnType<typeof setInterval> | undefined;
    const onMouseMove = (e: { lngLat: { lng: number; lat: number } }) => {
        cursorSample = layer ? layer.sampleAt(e.lngLat) : null;
    };

    const onTimestamp = (ts: number): void => {
        timelineTs = ts;
    };

    onMount(() => {
        applyMode();
        store.on('timestamp', onTimestamp);

        statusInterval = setInterval(() => {
            hiddenForGlobe = layer?.isHiddenForGlobe() ?? false;
            const counts = layer?.getDebugCounts();
            windowStats = counts?.window ?? null;
            instantLoading = !!counts && (counts.deg0Pending > 0 || counts.correctionPending > 0);
            if (debugEnabled && counts) {
                debugCounts = counts;
                requests = stepTileStats();
                now = performance.now();
            }
        }, 300);

        if (debugEnabled) {
            map.maplibreMap.on('mousemove', onMouseMove);
        }
    });

    onDestroy(() => {
        clearInterval(statusInterval);
        clearTimeout(windowTimer);
        store.off('timestamp', onTimestamp);
        document.removeEventListener('pointerdown', onOutsidePointer, true);
        unwatchPane();
        if (debugEnabled) {
            map.maplibreMap.off('mousemove', onMouseMove);
        }
        stopDeg0Watch?.();
        disableLayer();
    });
</script>

<style lang="less">
    .debug-float {
        position: fixed;
        top: 60px;
        left: 10px;
        z-index: 1000;
        box-sizing: border-box;
        width: min(360px, calc(100vw - 20px));
        padding: 6px 10px 10px;
        border-radius: 8px;
        background: rgba(20, 20, 20, 0.92);
        color: #fff;
    }

    .debug-float__header {
        width: 100%;
        padding: 4px 0;
        border: 0;
        background: none;
        color: inherit;
        font-weight: 600;
        text-align: left;
        cursor: pointer;
    }

    .debug-float__content {
        max-height: calc(100vh - 160px);
        overflow-y: auto;
        overscroll-behavior: contain;

        &.hidden {
            display: none;
        }
    }

    .row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 5px;
    }

    .elevation {
        height: 24px;
        margin-top: 6px;
    }

    .offset {
        height: 24px;
    }

    .unit {
        color: #a9adb3; // Windy's --color-text-secondary is a light yellow in dark content
        font-size: 11.5px;
    }

    .unavailable {
        opacity: 0.5;
    }

    .window-label {
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 15px;
        margin-top: 4px;
        font-size: 11.5px;
    }

    .reset {
        padding: 0 2px;
        border: 0;
        background: none;
        color: #b5b5b5;
        font: inherit;
        font-size: 12px;
        cursor: pointer;

        &:hover,
        &:focus-visible {
            color: var(--color-text-primary);
        }
    }

    .settings {
        flex: 0 0 auto;
        height: 36px;
        padding: 0 9px;
        border: 1px solid rgba(255, 255, 255, 0.25);
        border-radius: 7px;
        background: transparent;
        color: #b5b5b5;
        font: inherit;
        font-size: 13px;
        white-space: nowrap;
        cursor: pointer;
    }

    .settings--set {
        color: var(--color-text-primary);
    }

    .settings--open {
        background: rgba(255, 255, 255, 0.14);
    }

    .settings-popover {
        position: fixed;
        left: 10px;
        right: 10px;
        z-index: 9000;
        box-sizing: border-box;
        padding: 10px 14px 12px;
        border-radius: 10px;
        background: var(--color-background-primary);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
        color: var(--color-text-primary);
        font-size: 14px;
    }

    .settings-popover__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-weight: 600;
    }

    .settings-popover__close {
        width: 36px;
        height: 36px;
        padding: 0;
        border: 0;
        background: none;
        color: #c9c9c9;
        font-size: 20px;
        cursor: pointer;
    }

    .settings-popover__label {
        color: #a9adb3;
        font-size: 12px;
    }

    .settings-popover__row {
        display: flex;
        align-items: center;
        gap: 8px;
        height: 40px;
    }

    .touch {
        .elevation {
            gap: 8px;
            height: 40px;
        }

        .unit {
            font-size: 13px;
        }

        .window-label {
            height: 14px;
            font-size: 12.5px;
        }

        .reset {
            height: 28px;
            padding: 0 4px;
            font-size: 15px;
        }
    }

    .ignored {
        text-decoration: line-through;
        opacity: 0.6;
    }
</style>

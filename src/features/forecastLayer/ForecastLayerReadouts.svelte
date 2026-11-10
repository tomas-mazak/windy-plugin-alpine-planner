<div class="rounded-box rounded-box--with-border mt-10">
    <div class="size-xxs"><b>Forecast layer</b></div>
    <div class="size-xxs">
        { state.mode }: { state.active ? 'active' : state.mode === 'instant' ? 'inactive (Instant)' : `inactive (${ state.reason })` }
    </div>
    {#if state.window && state.selection}
        {@const { steps, spacingH, clipped, dropped } = state.selection}
        <div class="size-xxs">
            window { formatWindyTime(state.window.start) } → { formatWindyTime(state.window.end) }
            ({ ((state.window.end - state.window.start) / HOUR).toFixed(2) } h);
            { steps.length } steps { formatWindyTime(steps[0]) } … { formatWindyTime(steps[steps.length - 1]) },
            spacing { spacingH.join(', ') || '-' } h; { clipped ? `clipped, ${ dropped } dropped` : 'not clipped' }
        </div>
    {/if}
    <div class="size-xxs">
        hooks: interpolator { onOff(hooks.interpolator) }, picker { onOff(hooks.picker) }, range { onOff(hooks.rangeControl) },
        Windy layer '{ hooks.windyLayerId ?? '-' }' { hooks.windyLayerHidden ? 'hidden' : 'visible' }, user control { hooks.userControl ?? '-' }
    </div>
    <div class="size-xxs">
        requests: in flight { requests.inFlight }, queued { requests.queued }, done { requests.done }, failed { requests.failed },
        aborted { requests.aborted }; step cache { requests.cached } ({ requests.cachedMB.toFixed(1) } / { requests.budgetMB } MB)
    </div>
    <div class="size-xxs">
        fold queue { queue.queued }; tile-step { queue.lastJobMs?.toFixed(1) ?? '-' } ms (max { queue.maxJobMs.toFixed(1) }),
        longest slice { queue.maxSliceMs.toFixed(1) } ms; data textures { layer?.dataMB.toFixed(1) ?? '-' } MB (GPU),
        elevation textures { layer?.elevationTextures ?? '-' }
    </div>
    {#if folds}
        <div class="size-xxs">
            folds: { folds.complete } / { folds.tiles } complete, steps { folds.loaded } / { folds.needed }, failed { folds.failed } (window steps { folds.failedSteps })
        </div>
    {/if}
    {#if layer}
        <div class="size-xxs">
            layer z{ layer.tileZ ?? '-' } (data z{ layer.dataZ ?? '-' }), render tiles { layer.renderTiles }{ layer.previous ? ' (+ previous)' : '' },
            uploads { layer.uploads }, last { layer.lastUploadMs?.toFixed(1) ?? '-' } ms
            { layer.lastUploadAt !== null ? `${ ((now - layer.lastUploadAt) / 1000).toFixed(1) } s ago` : '' },
            coloured { layer.colored }, renders { layer.renders }
        </div>
    {/if}
    <div class="size-xxs mt-5">{ cursorText }</div>
    {#each correctionLines as line}
        <div class="size-xxs">{ line }</div>
    {/each}
</div>

<script lang="ts">
    import { map } from '@windy/map';
    import { onDestroy, onMount } from 'svelte';

    import { getForecastState, type ForecastState } from './controller';
    import { foldQueueStats, type FoldQueueStats } from '../../lib/foldQueue';
    import { stepTileStats, type StepTileStats } from '../../lib/stepTiles';
    import { formatWindyTime } from '../../lib/windyTime';
    import { getHooksStatus, type HooksStatus } from './windyHooks';

    import type { FoldStats } from './foldSource';
    import type { LayerCounts } from './layer';

    const HOUR = 3600 * 1000;
    const K = 273.15;

    let state: Readonly<ForecastState> = getForecastState();
    let hooks: HooksStatus = getHooksStatus();
    let requests: StepTileStats = stepTileStats();
    let queue: FoldQueueStats = foldQueueStats();
    let correctionLines: string[] = [];
    let folds: FoldStats | null = null;
    let layer: LayerCounts | null = null;
    let now = performance.now();
    let cursorText = 'hover the map in Min / Max (or Instant + correction) for the readout';

    const onOff = (on: boolean): string => (on ? 'on' : 'off');
    const celsius = (k: number): string => (Number.isNaN(k) ? '–' : (k - K).toFixed(1));

    function poll(): void {
        state = { ...getForecastState() };
        hooks = getHooksStatus();
        requests = stepTileStats();
        queue = foldQueueStats();
        folds = state.source?.stats() ?? null;
        layer = state.layer?.getDebugCounts() ?? null;
        now = performance.now();
    }

    // At the cursor, from cached steps only: the folded value (as the map and the picker), the point series' own
    // extreme and its time, and every step's value (°C, – where not loaded).
    let cursorRequest = 0;
    async function onMouseMove(e: { lngLat: { lng: number; lat: number } }): Promise<void> {
        const source = getForecastState().source;
        if (!source) {
            cursorText = 'hover the map in Min / Max (or Instant + correction) for the readout';
            correctionLines = [];
            return;
        }
        const request = ++cursorRequest;
        const sample = await source.inspect(e.lngLat, map.maplibreMap.getZoom());
        if (request !== cursorRequest) {
            return;
        }
        if (!sample) {
            cursorText = 'no data at the cursor (or no step loaded)';
            correctionLines = [];
            return;
        }
        const { kind, steps, instant } = source.context;
        const label = instant ? 'value' : kind;
        cursorText =
            `${label} ${celsius(sample.value)} °C (${sample.value.toFixed(2)} K); point series ${label} ` +
            `${celsius(sample.extreme)} °C at ${formatWindyTime(steps[sample.stepIndex])}; steps: ` +
            sample.series.map(celsius).join(' ');
        const c = sample.correction;
        if (!c) {
            correctionLines = [];
            return;
        }
        const branch = ['', '① below z_s', '② profile', '③ above top'][c.branch];
        const tile = c.tile;
        const clamps = getForecastState().layer?.bandClampsAt(e.lngLat);
        correctionLines = [
            `h ${c.h.toFixed(0)} m, z_s ${c.zs.toFixed(0)} m; T2m ${celsius(c.t2m)} °C → corrected ${celsius(sample.value)} °C`,
            `at the extreme's step, nearest node: ${branch}; below ` +
                (c.below ? `${c.below.level} ${c.below.gh.toFixed(0)} m ${celsius(c.below.t)} °C` : '(no level)') +
                ', L0 ' +
                (c.l0 ? `${c.l0.level} ${c.l0.gh.toFixed(0)} m ${celsius(c.l0.t)} °C` : '(no level)') +
                `, T_free(z_s) ${celsius(c.tFree)} °C, Δ ${c.delta.toFixed(1)} K, d ${c.d.toFixed(0)} m, w ${c.w.toFixed(2)}; ` +
                c.profile.map(p => `${p.level} ${p.gh.toFixed(0)} m ${celsius(p.t)}`).join(', '),
            tile
                ? `tile: bands z_s ${tile.oLo} … +${tile.oLo + tile.S * (tile.K - 1)} m, K ${tile.K}, S ${tile.S} m, ` +
                  `levels ${tile.levels.join(' ') || '-'}; band clamps ${clamps ? `${clamps.outside} / ${clamps.nodes}` : '-'}; ` +
                  `fold ${tile.foldMB.toFixed(1)} MB`
                : 'tile: not loaded',
        ];
    }

    let interval: ReturnType<typeof setInterval> | undefined;

    onMount(() => {
        interval = setInterval(poll, 300);
        map.maplibreMap.on('mousemove', onMouseMove);
    });

    onDestroy(() => {
        clearInterval(interval);
        map.maplibreMap.off('mousemove', onMouseMove);
    });
</script>

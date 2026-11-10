<div class:touch={ isMobileOrTablet }>
    {#if state.reason !== 'not temperature at surface'}
        <div class="row">
            <PillSwitch items={ MODES } value={ mode } label="Temperature mode" on:change={ e => setMode(e.detail) } />
        </div>
        <div class="row correction">
            <Toggle checked={ correction } disabled={ state.correctionAvailable === false } on:change={ onCorrectionChange }>
                Lapse rate correction
            </Toggle>
            {#if state.correctionAvailable === false}
                <span class="secondary">· not with { state.modelName }</span>
            {/if}
        </div>
    {:else}
        <div class="not-temp">
            <span class="secondary">{ pausedText }only for Temperature at surface</span>
            <button type="button" class="button size-s show-temp" on:click={ showTemperature }>Show temperature</button>
        </div>
    {/if}

    <StatusLines lines={ statusLines } />
</div>

<script lang="ts">
    import { isMobileOrTablet } from '@windy/rootScope';
    import store from '@windy/store';
    import { onDestroy, onMount } from 'svelte';

    import {
        getForecastState,
        setForecastCorrection,
        setForecastMode,
        startForecastLayer,
        stopForecastLayer,
        type ForecastMode,
        type ForecastState,
    } from './controller';
    import { reportStatus } from '../../lib/testApi';
    import { formatWindyTime } from '../../lib/windyTime';
    import { forecastWindowStatus } from './forecastStatus';
    import PillSwitch from '../../ui/PillSwitch.svelte';
    import StatusLines, { type StatusLine } from '../../ui/StatusLines.svelte';
    import Toggle from '../../ui/Toggle.svelte';

    const MODES: { id: ForecastMode; label: string }[] = [
        { id: 'instant', label: 'Instant' },
        { id: 'min', label: 'Min' },
        { id: 'max', label: 'Max' },
    ];

    // Remembered by the plugin (src/lib/pluginState.ts): the initial values in, the user's changes out.
    export let mode: ForecastMode;
    export let correction: boolean;
    let state: Readonly<ForecastState> = getForecastState();
    let loading: { loaded: number; needed: number } | null = null; // steps
    let failedSteps = 0;
    let settled = false; // every step of the current source's data tiles in view is loaded or failed

    $: corrected = correction && state.correctionAvailable !== false;
    $: modeLabel = MODES.find(m => m.id === mode)!.label;

    // The tab's summary: the mode and the correction, or why they're paused.
    export let summary = '';
    $: summary =
        state.reason === 'not temperature at surface'
            ? mode !== 'instant' || correction
                ? 'paused'
                : 'n/a'
            : `${modeLabel}${corrected ? ' · corr.' : ''}`;

    // "Max paused: ", "Correction paused: " or nothing, before "only for Temperature at surface"
    $: pausedText = mode !== 'instant' ? `${modeLabel} paused: ` : correction ? 'Correction paused: ' : '';

    function status(s: Readonly<ForecastState>, m: ForecastMode, corr: boolean, load: typeof loading, failed: number): StatusLine[] {
        if (s.reason === 'globe') {
            return [{ text: 'Hidden in 3D globe view' }];
        }
        if (s.reason) {
            return [];
        }
        if (m === 'instant') {
            return corr && load ? [{ text: 'Loading …' }] : [];
        }
        if (!s.selection) {
            return [];
        }
        const lines = forecastWindowStatus({ selection: s.selection, loading: load, failed, premiumStart: s.premiumStart }, formatWindyTime);
        return lines.map(text => ({ text }));
    }

    $: statusLines = status(state, mode, corrected, loading, failedSteps);
    // For the end-to-end tests (src/lib/testApi.ts): loading while the layer is active and not settled.
    $: reportStatus('temp', { lines: statusLines.map(l => l.text), loading: state.active && !settled, failed: failedSteps });

    function setMode(next: ForecastMode): void {
        mode = next;
        setForecastMode(mode);
        poll();
    }

    function onCorrectionChange(e: CustomEvent<boolean>): void {
        correction = e.detail;
        setForecastCorrection(correction);
        poll();
    }

    function showTemperature(): void {
        void store.set('overlay', 'temp');
        store.set('level', 'surface');
    }

    // The controller's state changes outside Svelte (events, loading): polled, like the mask panel's status.
    function poll(): void {
        state = { ...getForecastState() };
        const stats = state.source?.stats();
        loading = stats && stats.loaded + stats.failed < stats.needed ? stats : null;
        failedSteps = stats?.failedSteps ?? 0;
        settled = !!stats && stats.needed > 0 && stats.loaded + stats.failed >= stats.needed;
    }

    let interval: ReturnType<typeof setInterval> | undefined;

    onMount(() => {
        startForecastLayer(mode, correction);
        interval = setInterval(poll, 300);
        poll();
    });

    onDestroy(() => {
        clearInterval(interval);
        stopForecastLayer();
    });
</script>

<style lang="less">
    .row {
        display: flex;
        align-items: center;
        margin-top: 5px;
    }

    .correction {
        gap: 6px;
        margin-top: 3px;
    }

    .secondary {
        color: #a9adb3; // Windy's --color-text-secondary is a light yellow in dark content
        font-size: 11px;
        white-space: nowrap;
    }

    .not-temp {
        margin-top: 6px;

        .secondary {
            display: block;
            font-size: 12px;
            white-space: normal;
        }
    }

    // Windy's .button, with the panel's height
    .show-temp {
        height: 24px;
        margin: 5px 0 0;
        padding: 0 10px;
        font-family: inherit;
    }

    .touch {
        .correction .secondary {
            font-size: 12px;
        }

        .not-temp {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            min-height: 40px;
            margin-top: 4px;

            .secondary {
                font-size: 13px;
            }
        }

        .show-temp {
            flex: 0 0 auto;
            height: 34px;
            margin: 0;
            padding: 0 12px;
            font-size: 13px;
            white-space: nowrap;
        }
    }
</style>

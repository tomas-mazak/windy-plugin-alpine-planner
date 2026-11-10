<div class="range-slider" class:range-slider--touch={ isMobileOrTablet } class:disabled>
    <div class="track">
        <div class="fill" style="left: { percent(from) }%; right: { 100 - percent(to) }%"></div>
    </div>
    {#if tick !== null}
        <!-- The timeline time on the slider (clamped to the ends) -->
        <div class="tick" title="Timeline" style="left: calc(var(--thumb) / 2 + { tick } * (100% - var(--thumb)) - 1px)"></div>
    {/if}
    <input
        type="range"
        aria-label={ labels[0] }
        {min}
        {max}
        {step}
        value={ from }
        {disabled}
        style="z-index: { onTop === 'from' ? 2 : 1 }"
        on:input={ onFromInput }
    />
    <input
        type="range"
        aria-label={ labels[1] }
        {min}
        {max}
        {step}
        value={ to }
        {disabled}
        style="z-index: { onTop === 'to' ? 2 : 1 }"
        on:input={ onToInput }
    />
</div>

<script lang="ts">
    import { isMobileOrTablet } from '@windy/rootScope';
    import { createEventDispatcher } from 'svelte';

    export let min: number;
    export let max: number;
    export let step: number;
    export let gap: number;
    export let from: number;
    export let to: number;
    export let disabled = false;
    export let labels: [string, string] = ['Lower elevation bound', 'Upper elevation bound'];
    export let tick: number | null = null; // 0 … 1 along the track, or none

    const dispatch = createEventDispatcher<{ change: { from: number; to: number } }>();

    // The most recently used handle stays on top, so two handles that meet
    // can always be separated again.
    let top: 'from' | 'to' = 'to';
    // With a zero gap, handles that meet at an end: the one that can still move goes on top.
    $: onTop = from === to && to >= max ? 'from' : from === to && from <= min ? 'to' : top;

    const percent = (value: number) => ((value - min) / (max - min || 1)) * 100;

    function onFromInput(e: Event): void {
        const input = e.currentTarget as HTMLInputElement;
        from = Math.min(Number(input.value), to - gap);
        input.value = String(from); // the DOM still shows the unclamped value otherwise
        top = 'from';
        dispatch('change', { from, to });
    }

    function onToInput(e: Event): void {
        const input = e.currentTarget as HTMLInputElement;
        to = Math.max(Number(input.value), from + gap);
        input.value = String(to);
        top = 'to';
        dispatch('change', { from, to });
    }
</script>

<style lang="less">
    @import './slider.less';

    .range-slider {
        .slider();
        flex: 1 1 auto;
        min-width: 0;
    }

    .tick {
        position: absolute;
        bottom: 0;
        width: 2px;
        height: 7px;
        background: #5ec8f2;

        .range-slider--touch & {
            height: 9px;
        }
    }

    // Only the thumbs take pointer events, so both handles can be reached.
    input[type='range'] {
        pointer-events: none;
    }
    input[type='range']::-webkit-slider-thumb {
        pointer-events: auto;
    }
    input[type='range']::-moz-range-thumb {
        pointer-events: auto;
    }
</style>

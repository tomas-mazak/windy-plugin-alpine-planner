<div class="offset-slider" class:offset-slider--touch={ isMobileOrTablet } class:disabled title="Offset">
    <div class="track">
        <div class="fill" style="left: { Math.min(percent(value), percent(0)) }%; right: { 100 - Math.max(percent(value), percent(0)) }%"></div>
        <div class="zero" style="left: { percent(0) }%"></div>
    </div>
    <input type="range" aria-label="Freezing level offset" {min} {max} {step} {value} {disabled} on:input={ onInput } />
</div>

<script lang="ts">
    import { isMobileOrTablet } from '@windy/rootScope';
    import { createEventDispatcher } from 'svelte';

    export let min: number;
    export let max: number;
    export let step: number;
    export let value: number;
    export let disabled = false;

    const dispatch = createEventDispatcher<{ change: number }>();

    const percent = (v: number) => ((v - min) / (max - min)) * 100;

    function onInput(e: Event): void {
        dispatch('change', Number((e.currentTarget as HTMLInputElement).value));
    }
</script>

<style lang="less">
    @import './slider.less';

    // Same look as RangeSlider, with the fill running from the 0 tick to the handle.
    .offset-slider {
        .slider();
        flex: 1 1 auto;
        min-width: 0;
    }

    .zero {
        position: absolute;
        top: -3px;
        bottom: -3px;
        width: 1px;
        background: rgba(255, 255, 255, 0.5);

        .offset-slider--touch & {
            top: -4px;
            bottom: -4px;
        }
    }
</style>

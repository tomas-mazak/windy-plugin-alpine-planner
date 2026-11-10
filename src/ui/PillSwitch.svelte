<!-- Windy's switch (.switch.switch--background: pill items, the selected one in --color-ui-primary), full width, with
     the panel's item heights. Items are buttons, so they're keyboard-reachable. -->
<nav class="switch switch--background pill-switch" class:pill-switch--touch={ isMobileOrTablet } aria-label={ label }>
    {#each items as item}
        <button type="button" class="switch__item" class:selected={ item.id === value } aria-pressed={ item.id === value }
            on:click={ () => dispatch('change', item.id) }>{ item.label }</button>
    {/each}
</nav>

<script lang="ts" generics="T extends string">
    import { isMobileOrTablet } from '@windy/rootScope';
    import { createEventDispatcher } from 'svelte';

    export let items: { id: T; label: string }[];
    export let value: T;
    export let label: string;

    const dispatch = createEventDispatcher<{ change: T }>();
</script>

<style lang="less">
    .pill-switch {
        display: flex;
        flex: 1 1 auto;
        min-width: 0;
    }

    .switch__item {
        flex: 1 1 0;
        min-width: 0;
        height: 22px;
        padding: 0 4px;
        border: 0;
        font: inherit;
        font-size: 12px;
        white-space: nowrap;
        overflow: hidden;

        &:not(.selected) {
            background: none;
        }

        .pill-switch--touch & {
            height: 30px;
            font-size: 13.5px;
        }
    }
</style>

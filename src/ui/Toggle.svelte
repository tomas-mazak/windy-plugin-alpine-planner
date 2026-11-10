<!-- Windy's toggle (.checkbox / .checkbox--off: a switch icon before the text). It's a div in Windy, so the switch
     semantics and keys are added here. -->
<div class="checkbox toggle" class:checkbox--off={ !checked } class:toggle--disabled={ disabled } class:toggle--touch={ isMobileOrTablet }
    role="switch" tabindex={ disabled ? -1 : 0 } aria-checked={ checked } aria-disabled={ disabled } {title}
    on:click={ toggle } on:keydown={ onKeydown }>
    <slot />
</div>

<script lang="ts">
    import { isMobileOrTablet } from '@windy/rootScope';
    import { createEventDispatcher } from 'svelte';

    export let checked: boolean;
    export let disabled = false;
    export let title: string | undefined = undefined;

    const dispatch = createEventDispatcher<{ change: boolean }>();

    function toggle(): void {
        if (!disabled) {
            dispatch('change', !checked);
        }
    }

    function onKeydown(e: KeyboardEvent): void {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault(); // Space would scroll
            toggle();
        }
    }
</script>

<style lang="less">
    .toggle {
        height: 22px;
        font-size: 12px;
        white-space: nowrap;
    }

    .toggle--touch {
        height: auto;
        min-height: 38px;
        font-size: 14px;
    }

    .toggle--disabled {
        opacity: 0.5;
        cursor: default;
    }
</style>

<section class="alpine-planner" class:alpine-planner--touch={ isMobileOrTablet } bind:this={ root }>
    <!-- Row 1 keeps clear of Windy's close × (desktop: in the box's 40 px right padding). -->
    <div class="alpine-planner__top">
        <nav class="switch switch--background alpine-planner__tabs" role="tablist" aria-label="Tools">
            {#each TOOLS as t}
                <button type="button" class="switch__item alpine-planner__tab" class:selected={ state.activity.tool === t.id } role="tab"
                    aria-selected={ state.activity.tool === t.id } on:click={ () => setTool(t.id) }>
                    <span class="alpine-planner__caption">{ t.caption }</span>
                    <span class="alpine-planner__summary">{ t.id === 'temp' ? tempSummary : maskSummary }</span>
                </button>
            {/each}
        </nav>
        <button class="alpine-planner__info" aria-label="About Alpine planner" bind:this={ infoButton } on:click={ () => (helpOpen = true) }>
            <svg width={ isMobileOrTablet ? 22 : 17 } height={ isMobileOrTablet ? 22 : 17 } viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9.5"></circle>
                <line x1="12" y1="11" x2="12" y2="17"></line>
                <line x1="12" y1="7.5" x2="12" y2="7.6"></line>
            </svg>
        </button>
    </div>

    <!-- Both tools stay mounted (their layers keep running); only the selected one is shown. -->
    <div class="alpine-planner__body">
        <div hidden={ state.activity.tool !== 'temp' }>
            <ForecastLayerPanel bind:mode={ state.activity.temp.mode } bind:correction={ state.activity.temp.correction }
                bind:summary={ tempSummary } />
        </div>
        <div hidden={ state.activity.tool !== 'mask' }>
            <ElevationMaskPanel bind:mode={ state.activity.mask.mode } bind:isoMode={ state.activity.mask.isoMode }
                bind:lapseCorrection={ state.activity.mask.isoCorrection } bind:isoWindow={ state.activity.mask.isoWindow }
                bind:from={ state.values.from } bind:to={ state.values.to } bind:offset={ state.values.offset }
                bind:summary={ maskSummary } active={ state.activity.tool === 'mask' } />
        </div>
    </div>

    {#if helpOpen}
        <HelpModal startTab={ state.activity.tool === 'temp' ? 'temp' : HELP_TAB[state.activity.mask.mode] } on:close={ closeHelp } />
    {/if}
</section>

<script lang="ts">
    import { isMobileOrTablet } from '@windy/rootScope';
    import { onDestroy, onMount, tick } from 'svelte';

    import ElevationMaskPanel from './features/elevationMask/ElevationMaskPanel.svelte';
    import ForecastLayerPanel from './features/forecastLayer/ForecastLayerPanel.svelte';
    import HelpModal, { type HelpTab } from './features/help/HelpModal.svelte';

    import { loadState, saveState, type PluginState, type Tool } from './lib/pluginState';
    import { installTestApi } from './lib/testApi';

    import type { MaskMode } from './features/elevationMask/layer';

    const TOOLS: { id: Tool; caption: string }[] = [
        { id: 'temp', caption: 'TEMP' },
        { id: 'mask', caption: 'MASK' },
    ];
    const SAVE_DEBOUNCE_MS = 300; // slider drags

    // The help opens on the selected tool's tab: Temp, or the current mask mode's (Off: About); it isn't remembered.
    const HELP_TAB: Record<'off' | MaskMode, HelpTab> = { off: 'about', elevation: 'elevation', freezing: 'isotherm' };

    // The one owner of the remembered state (src/lib/pluginState.ts): restored once on open, bound into the panels,
    // saved on every change (debounced), and when the plugin closes or the page is hidden or left, so "fresh" counts
    // from the last use.
    let state: PluginState = loadState(Date.now());
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let root: HTMLElement | undefined;

    // The end-to-end tests' read-only interface (src/lib/testApi.ts), only with its localStorage flag. Installed here,
    // before the panels mount and patch Windy.
    const removeTestApi = installTestApi(() => state, () => root);

    function save(): void {
        clearTimeout(saveTimer);
        saveState(state, Date.now());
    }

    // Any change of a stored field, by the user or by the plugin itself (e.g. the window clipped to a new run)
    $: {
        void state;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
    }

    const onVisibilityChange = (): void => {
        if (document.visibilityState === 'hidden') {
            save();
        }
    };

    onMount(() => {
        document.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener('pagehide', save);
    });

    onDestroy(() => {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.removeEventListener('pagehide', save);
        save();
        removeTestApi();
    });

    let tempSummary = '';
    let maskSummary = '';
    let helpOpen = false;
    let infoButton: HTMLButtonElement;

    function setTool(next: Tool): void {
        state.activity.tool = next;
    }

    async function closeHelp(): Promise<void> {
        helpOpen = false;
        await tick();
        infoButton?.focus();
    }
</script>

<style lang="less">
    // Desktop: Windy's box is 320 × 200 px (max-height, padding 0.5em 1em, right 40 px for its ×); we fill its content
    // height exactly, so the box never changes size. Mobile: full width, at most 200 px, padding 5 px.
    .alpine-planner {
        box-sizing: border-box;
        width: 100%;
        height: calc(200px - 1em);
    }

    .alpine-planner--touch {
        height: auto;
        padding: 0 3px;
    }

    .alpine-planner__top {
        display: flex;
        align-items: center;
        gap: 4px;
        height: 28px;

        .alpine-planner--touch & {
            height: auto;
        }
    }

    .alpine-planner__tabs {
        display: flex;
        flex: 1 1 auto;
        min-width: 0;
    }

    // Desktop: sized by content, so a longer summary ("Instant · corr.") takes room from a shorter one instead of being
    // cut at half the width; mobile: equal halves of the full width.
    .alpine-planner__tab {
        flex: 1 1 auto;
        justify-content: flex-start;
        min-width: 0;
        height: 24px;
        padding: 0 6px;
        border: 0;
        font: inherit;
        font-size: 12px;
        white-space: nowrap;

        &:not(.selected) {
            background: none;
        }

        .alpine-planner--touch & {
            flex: 1 1 0;
            flex-direction: column;
            align-items: flex-start;
            justify-content: center;
            height: 34px;
            padding: 1px 12px;
            font-size: 13px;
        }
    }

    // Desktop: a small badge before the summary; mobile: the caption above it.
    .alpine-planner__caption {
        flex: 0 0 auto;
        margin-right: 5px;
        padding: 1px 4px 0;
        border-radius: 3px;
        background: rgba(255, 255, 255, 0.18);
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.06em;
        line-height: 13px;

        .selected & {
            background: rgba(0, 0, 0, 0.28);
        }

        .alpine-planner--touch & {
            margin: 0;
            padding: 0;
            background: none;
            color: #b5b5b5;
            font-size: 9.5px;
        }

        .alpine-planner--touch .selected & {
            color: rgba(255, 255, 255, 0.8);
        }
    }

    .alpine-planner__summary {
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .alpine-planner__info {
        display: flex;
        flex: 0 0 22px;
        align-items: center;
        justify-content: center;
        height: 24px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: none;
        color: #c9c9c9;
        cursor: pointer;

        &:hover,
        &:focus-visible {
            color: var(--color-text-primary);
        }

        .alpine-planner--touch & {
            flex-basis: 36px;
            height: 36px;
        }
    }

    // Every row below row 1 uses the full width: into Windy's 40 px padding, clear of its × (desktop only).
    .alpine-planner__body {
        margin-right: -30px;

        .alpine-planner--touch & {
            margin-right: 0;
        }
    }
</style>

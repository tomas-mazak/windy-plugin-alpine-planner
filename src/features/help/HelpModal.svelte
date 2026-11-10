<!-- The help modal: the in-app user documentation. Mounted to document.body, so no
     ancestor of the plugin slot clips or transforms it. Keys and pointer events stop at the root: Windy's body
     keydown handler moves the timeline on arrow keys, and its document handlers act on clicks. -->
<div class="help" class:compact use:portal on:keydown={ onKeydown } on:mousedown={ stop } on:touchstart={ stop }
    on:pointerdown={ stop } on:click={ stop } on:wheel={ stop } on:contextmenu={ stop }>
    {#if !compact}
        <div class="help__backdrop" on:click={ close }></div>
    {/if}
    <div class="help__box" role="dialog" aria-modal="true" aria-label="About Alpine planner" bind:this={ box }>
        <div class="help__header">
            <span class="help__title"><span class="help__titleicon">🏔</span> Alpine planner</span>
            <span class="help__version">v{ config.version }</span>
            <button class="help__close" aria-label="Close" bind:this={ closeButton } on:click={ close }>×</button>
        </div>

        <div class="switch switch--background help__tabs" role="tablist">
            {#each TABS as t}
                <button class="switch__item help__tab" class:selected={ tab === t.id } role="tab" aria-selected={ tab === t.id }
                    tabindex={ tab === t.id ? 0 : -1 } on:click={ () => setTab(t.id) } on:keydown={ onTabKeydown }>{ t.label }</button>
            {/each}
        </div>

        <div class="help__content" bind:this={ content }>
            {#if tab === 'about'}
                <p class="help__lead">A set of tools for planning in the mountains: get more from Windy's temperature layer, dim the terrain you can rule out.</p>
                <div class="help__cards">
                    <button class="help__card" on:click={ () => setTab('temp') }>
                        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="#e8846a" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 4 a2.5 2.5 0 0 1 5 0 v12 a5 5 0 1 1 -5 0 Z"></path><line x1="14.5" y1="10" x2="14.5" y2="19"></line></svg>
                        <span><b>TEMP · Temperature layer</b><br>The lowest or highest temperature over a time window, optionally adjusted to the real terrain altitude.</span>
                    </button>
                    <button class="help__card" on:click={ () => setTab('elevation') }>
                        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="#f0a81c" stroke-width="1.8" aria-hidden="true"><path d="M2 23 L10 9 L15 16 L19 11 L26 23 Z" stroke-linejoin="round"></path><line x1="2" y1="14" x2="26" y2="14" stroke-dasharray="3 2"></line></svg>
                        <span><b>MASK · Elevation</b><br>Terrain between two altitudes stays clear; everything else is dimmed. Doesn't depend on the forecast.</span>
                    </button>
                    <button class="help__card" on:click={ () => setTab('isotherm') }>
                        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="#5ec8f2" stroke-width="1.8" aria-hidden="true"><path d="M14 3 L14 25 M5 8 L23 20 M23 8 L5 20" stroke-linecap="round"></path></svg>
                        <span><b>MASK · Isotherm</b><br>Terrain where the forecast air is at or below 0 °C stays clear: at one time, or over a time window (where it stayed frozen, where it froze at least once).</span>
                    </button>
                </div>
                <p class="help__hint">Both masks work on top of any Windy layer. Everything follows the forecast model selected in Windy.</p>
                <div class="help__note">
                    <b>A planning aid, not a safety tool.</b> It knows nothing about snow cover, avalanche danger or ground conditions, and it shows model forecasts, not measurements.
                    <button class="help__link" on:click={ () => setTab('limits') }>Read the limits</button>
                </div>
            {:else if tab === 'temp'}
                <h3>Temperature layer</h3>
                <p>Adds aggregation features to Windy's temperature layer. It works only with the temperature at the surface; on other layers the tool pauses.</p>
                <ul>
                    <li><b>Instant:</b> Windy's temperature at the timeline time.</li>
                    <li><b>Min / Max:</b> the lowest or highest temperature over a time window. Windy's timeline turns into a range selector: drag the window and set its length.</li>
                </ul>
                <h3>How Min and Max are found</h3>
                <p>Only the model's own forecast steps are compared; nothing is interpolated in time. The true peak usually falls between two steps, so Max reads a little low and Min a little high: a few tenths of a degree with 3-hourly steps, up to about 1–2 °C with 6-hourly steps. The status line shows how many steps were used and how far apart they are. Click the map: the picker shows the value with <i>Max</i> or <i>Min</i>, and when it occurs.</p>
                <h3>Lapse rate correction <span class="help__aside">(off by default)</span></h3>
                <p class="help__before-figure">The model's temperature belongs to its smoothed ground, often hundreds of metres above real valleys and below real summits. The correction moves it to the real terrain height, so valleys and ridges show up in the colours.</p>
                <svg class="help__figure" role="img" aria-label="A real summit lies above the smoothed model ground and comes out colder; a real valley lies below it and comes out warmer." width="100%" viewBox="0 0 480 160">
                    <path d="M0 120 L50 100 L90 40 L120 22 L150 50 L200 110 L240 135 L280 112 L330 60 L370 30 L410 58 L480 90 L480 160 L0 160 Z" fill="#8a9ba6"></path>
                    <path d="M0 95 L100 80 L200 88 L300 82 L400 70 L480 80" fill="none" stroke="#5ec8f2" stroke-width="2" stroke-dasharray="6 4"></path>
                    <text x="6" y="72" font-size="12" fill="#5ec8f2">model ground (smoothed)</text>
                    <text x="130" y="18" font-size="12" fill="#ffffff">summit: colder than the model says</text>
                    <text x="180" y="152" font-size="12" fill="#1b1b1b">valley: usually warmer</text>
                </svg>
                <ul>
                    <li>Above the model ground it uses the model's own temperatures higher up in the air.</li>
                    <li>Below it, it starts from the model's own surface temperature and blends into the free air over the first 300 m; deeper down it follows the free air at the standard rate (6.5 °C per km).</li>
                    <li>With Min / Max, every forecast step is corrected first, then the extreme is taken. The picker also shows the height the value is for.</li>
                </ul>
                <p class="help__tight">It's an estimate. Summits get the temperature of the free air at their height, not of a sunlit or frosty surface. Cold air pooling in valleys on clear nights is not in the model, so deep valleys can come out several degrees too warm, and on sunny mornings under warm air aloft they can look warmer than they are.</p>
                <p class="help__last help__hint">Not available with every model. It downloads several extra files per forecast step.</p>
            {:else if tab === 'elevation'}
                <h3>Elevation mask</h3>
                <p>Terrain between the two altitudes stays clear; terrain above and below is dimmed.</p>
                <ul>
                    <li>Drag the slider ends, or type into the number fields (10 m steps).</li>
                    <li>The top position, 8 000 m+, means no upper limit.</li>
                </ul>
                <h3>Typical uses</h3>
                <ul>
                    <li>The elevation band of an avalanche problem from the bulletin.</li>
                    <li>Terrain above a forecast snow line or below a cloud base.</li>
                    <li>Altitudes for acclimatisation or a hut-to-hut route.</li>
                </ul>
                <h3>Terrain data</h3>
                <p class="help__last">Heights come from a global elevation model with about 90 m resolution. Narrow ridges, couloirs and small summits are smoothed, so the edge of the mask can be off by tens of metres in steep terrain.</p>
            {:else if tab === 'isotherm'}
                <h3>Isotherm mask</h3>
                <p class="help__before-figure">Shows where the forecast air temperature is at or below 0 °C. Terrain above the freezing level stays clear; terrain below it is dimmed.</p>
                <svg class="help__figure" role="img" aria-label="Terrain above the 0 °C line stays clear, terrain below it is dimmed. The offset moves the line." width="100%" viewBox="0 0 480 150">
                    <defs><clipPath id="{ uid }-a"><path d="M0 140 L60 118 L110 72 L150 38 L190 76 L230 108 L270 124 L320 88 L360 50 L400 28 L440 66 L480 96 L480 150 L0 150 Z"></path></clipPath></defs>
                    <path d="M0 140 L60 118 L110 72 L150 38 L190 76 L230 108 L270 124 L320 88 L360 50 L400 28 L440 66 L480 96 L480 150 L0 150 Z" fill="#8a9ba6"></path>
                    <rect x="0" y="86" width="480" height="64" fill="#000000" fill-opacity="0.65" clip-path="url(#{ uid }-a)"></rect>
                    <line x1="0" y1="86" x2="480" y2="86" stroke="#5ec8f2" stroke-width="2"></line>
                    <line x1="0" y1="70" x2="480" y2="70" stroke="#5ec8f2" stroke-width="1.5" stroke-dasharray="5 4" stroke-opacity="0.7"></line>
                    <text x="6" y="64" font-size="12" fill="#5ec8f2">with offset +150 m</text>
                    <text x="6" y="100" font-size="12" fill="#5ec8f2">0 °C (freezing level)</text>
                    <text x="300" y="20" font-size="12" fill="#d9d9d9">frozen: clear</text>
                    <text x="190" y="142" font-size="12" fill="#d9d9d9">above 0 °C: dimmed</text>
                </svg>
                <h3>One time, or a time window</h3>
                <ul class="help__before-figure">
                    <li><b>Instant:</b> at Windy's timeline time.</li>
                    <li><b>Max:</b> clear only where it stayed frozen at every forecast step of the window.</li>
                    <li><b>Min:</b> clear where it froze at least once, e.g. an overnight refreeze.</li>
                    <li><b>Both:</b> shows the two together, with the band where it froze and thawed half dimmed.</li>
                </ul>
                <svg class="help__figure help__figure--legend" role="img" aria-label="Both: terrain that stayed frozen is clear, the band that froze and thawed is half dimmed, terrain that never froze is dimmed." width="100%" viewBox="0 0 480 150">
                    <defs><clipPath id="{ uid }-d"><path d="M0 140 L60 118 L110 72 L150 38 L190 76 L230 108 L270 124 L320 88 L360 50 L400 28 L440 66 L480 96 L480 150 L0 150 Z"></path></clipPath></defs>
                    <path d="M0 140 L60 118 L110 72 L150 38 L190 76 L230 108 L270 124 L320 88 L360 50 L400 28 L440 66 L480 96 L480 150 L0 150 Z" fill="#8a9ba6"></path>
                    <g clip-path="url(#{ uid }-d)">
                        <rect x="0" y="60" width="480" height="44" fill="#000000" fill-opacity="0.30"></rect>
                        <rect x="0" y="104" width="480" height="46" fill="#000000" fill-opacity="0.65"></rect>
                        <rect x="0" y="59" width="480" height="1.5" fill="#000000" fill-opacity="0.65"></rect>
                    </g>
                </svg>
                <div class="help__legend">
                    <span><span class="help__swatch" style="background: #8a9ba6"></span>stayed frozen</span>
                    <span><span class="help__swatch" style="background: #61707a"></span>froze and thawed</span>
                    <span><span class="help__swatch" style="background: #30373b"></span>never froze</span>
                </div>
                <p>The window is set with the slider in the plugin and doesn't follow Windy's timeline: scrub the timeline to see the layer underneath change while the mask stays. The blue tick marks the timeline time; ↺ resets the window to the timeline time + 12 h. Only forecast steps are compared, so a short thaw between two steps can be missed.</p>
                <h3>Model</h3>
                <p>Uses the forecast model selected in Windy, or ECMWF if that model has no freezing level. The status line names the model and run, and the time or window the mask shows.</p>
                <h3>Offset</h3>
                <p>Moves the line up or down by up to 500 m: a safety margin, or a rough snow line. In precipitation, snow often reaches a few hundred metres below the freezing level.</p>
                <h3>Lapse rate correction <span class="help__aside">(off by default)</span></h3>
                <p class="help__before-figure">Forecast models see smoothed terrain: valleys sit hundreds of metres higher in the model than in reality. When the air is frozen down to the model's ground, the model can't say how far below it the 0 °C level lies, so deep valleys get dimmed although they may be frozen.</p>
                <svg class="help__figure" role="img" aria-label="Without the correction, a real valley below the smoothed model ground is dimmed. With it, the 0 °C level is estimated below the valley floor and the valley stays clear." width="100%" viewBox="0 0 480 170">
                    <defs><clipPath id="{ uid }-b"><path d="M0 50 L40 66 L80 108 L115 128 L150 108 L190 66 L230 50 L230 150 L0 150 Z"></path></clipPath></defs>
                    <g>
                        <text x="0" y="14" font-size="12" font-weight="700" fill="#ffffff">Correction off</text>
                        <path d="M0 50 L40 66 L80 108 L115 128 L150 108 L190 66 L230 50 L230 150 L0 150 Z" fill="#8a9ba6"></path>
                        <path d="M0 76 L60 82 L115 88 L170 82 L230 76 L230 150 L0 150 Z" fill="#000000" fill-opacity="0.65" clip-path="url(#{ uid }-b)"></path>
                        <path d="M0 76 L60 82 L115 88 L170 82 L230 76" fill="none" stroke="#5ec8f2" stroke-width="2" stroke-dasharray="6 4"></path>
                        <text x="0" y="166" font-size="11" fill="#b5b5b5">0 °C at the model ground</text>
                    </g>
                    <g transform="translate(250 0)">
                        <defs><clipPath id="{ uid }-c"><path d="M0 50 L40 66 L80 108 L115 128 L150 108 L190 66 L230 50 L230 150 L0 150 Z"></path></clipPath></defs>
                        <text x="0" y="14" font-size="12" font-weight="700" fill="#ffffff">Correction on</text>
                        <path d="M0 50 L40 66 L80 108 L115 128 L150 108 L190 66 L230 50 L230 150 L0 150 Z" fill="#8a9ba6"></path>
                        <path d="M0 76 L60 82 L115 88 L170 82 L230 76" fill="none" stroke="#d9d9d9" stroke-width="1.2" stroke-dasharray="3 3" stroke-opacity="0.7"></path>
                        <rect x="0" y="140" width="230" height="10" fill="#000000" fill-opacity="0.65" clip-path="url(#{ uid }-c)"></rect>
                        <line x1="0" y1="140" x2="230" y2="140" stroke="#5ec8f2" stroke-width="2"></line>
                        <text x="0" y="166" font-size="11" fill="#b5b5b5">0 °C estimated below the valley</text>
                    </g>
                </svg>
                <p class="help__tight">With the correction on, the plugin estimates the temperature below the model ground the same way as the temperature layer does: it starts from the model's own surface temperature, blends into the free air over the first 300 m below the model ground, and follows the free air further down into the valleys. A valley can therefore come out dimmed even when the model's ground is frozen, if the free air at the valley's height is above 0 °C.</p>
                <p class="help__last help__hint">Clear-night cold pools aren't in the model: a valley floor can be frozen although it shows dimmed. It downloads more forecast data.</p>
            {:else}
                <h3 class="help__limits-title">Know the limits</h3>
                <div class="help__limits">
                    <p><b>Not a safety tool.</b> No snow cover, snow quality, avalanche danger or ice conditions. Always check the avalanche bulletin and local observations.</p>
                    <p><b>Forecasts, not measurements.</b> Everything comes from one run of one model. A time window can't reach back before that run's first step.</p>
                    <p><b>Air, not snow.</b> The freezing level and the temperatures describe the air. Snow can stay frozen in air above 0 °C (clear nights, shade), or soften below it (strong sun on south-facing slopes).</p>
                    <p><b>Forecast steps only.</b> Min and Max compare the model's steps, 1–6 hours apart. Peaks between steps are missed: Max temperatures read low, Min high, and a short thaw can go unnoticed.</p>
                    <p><b>Model resolution.</b> Models work on 2–13 km grids. Valley cold pools, foehn, and sun or shade on a single slope can be missed or misplaced.</p>
                    <p><b>Warm layer aloft.</b> When the air has several 0 °C levels, e.g. before freezing rain, only the highest is used: the frozen air below it shows as dimmed.</p>
                    <p><b>Below the model ground.</b> The lapse rate correction is an estimate from the free air. Deep valleys on clear nights are often several degrees colder than it shows; under warm air aloft they can also look too warm.</p>
                    <p><b>Summits.</b> The corrected temperature is that of the free air at the summit's height, without the effect of sun or night-time radiation on the surface.</p>
                    <p><b>Terrain detail.</b> About 90 m elevation data; small features are smoothed.</p>
                </div>
            {/if}
        </div>
    </div>
</div>

<script lang="ts" context="module">
    export type HelpTab = 'about' | 'temp' | 'elevation' | 'isotherm' | 'limits';
</script>

<script lang="ts">
    import { isMobile } from '@windy/rootScope';
    import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';

    import config from '../../pluginConfig';

    export let startTab: HelpTab = 'about';

    const TABS: { id: HelpTab; label: string }[] = [
        { id: 'about', label: 'About' },
        { id: 'temp', label: 'Temp' },
        { id: 'elevation', label: 'Elevation' },
        { id: 'isotherm', label: 'Isotherm' },
        { id: 'limits', label: 'Limits' },
    ];

    // Windy's own mobile layout flag (it picks the plugin's mobileUI with it): full screen there.
    const compact = isMobile;
    // Unique SVG clipPath ids per instance.
    const uid = `ap-help-${Math.random().toString(36).slice(2, 8)}`;

    const dispatch = createEventDispatcher<{ close: void }>();

    let tab: HelpTab = startTab;
    let box: HTMLDivElement;
    let content: HTMLDivElement;
    let closeButton: HTMLButtonElement;

    function portal(node: HTMLElement) {
        document.body.appendChild(node);
        return { destroy: () => node.remove() };
    }

    const stop = (e: Event) => e.stopPropagation();

    function close(): void {
        dispatch('close');
    }

    function setTab(next: HelpTab): void {
        tab = next;
        if (content) {
            content.scrollTop = 0;
        }
    }

    async function onTabKeydown(e: KeyboardEvent): Promise<void> {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
            return;
        }
        const i = TABS.findIndex(t => t.id === tab);
        setTab(TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length].id);
        await tick();
        box.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
    }

    // Keeps Tab inside the dialog (a simple first/last wrap).
    function onKeydown(e: KeyboardEvent): void {
        e.stopPropagation(); // not to Windy's body handler (arrows move the timeline, f opens search, ...)
        if (e.key !== 'Tab') {
            return;
        }
        const focusable = [...box.querySelectorAll<HTMLElement>('button:not([tabindex="-1"])')];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    }

    // Capture phase on window, before anything else sees it: Escape closes only the modal, not the plugin.
    function onWindowKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            e.stopPropagation();
            e.preventDefault();
            close();
        }
    }

    onMount(() => {
        window.addEventListener('keydown', onWindowKeydown, true);
        closeButton.focus();
    });

    onDestroy(() => {
        window.removeEventListener('keydown', onWindowKeydown, true);
    });
</script>

<style lang="less">
    // Colours, type and spacing of the help modal.
    .help {
        position: fixed;
        inset: 0;
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Roboto, Arial, sans-serif;
    }

    .help__backdrop {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
    }

    .help__box {
        --pad: 24px;
        position: relative;
        box-sizing: border-box;
        width: min(560px, calc(100vw - 32px));
        height: min(640px, calc(100vh - 48px));
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
        background: #2f2f2f;
        color: #ececec;
    }

    .compact .help__box {
        --pad: 16px;
        width: 100%;
        height: 100%;
        border-radius: 0;
        box-shadow: none;
        padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
    }

    .help__header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 14px var(--pad) 10px;
    }

    .help__title {
        flex-grow: 1;
        font-size: 18px;
        font-weight: 700;
        color: #ffffff;
    }

    .help__titleicon {
        font-size: 24px;
    }

    .help__version {
        font-size: 12px;
        color: #a8a8a8;
    }

    .help__close {
        width: 44px;
        height: 44px;
        margin-right: -10px;
        padding: 0;
        border: 0;
        background: none;
        color: #d0d0d0;
        font-size: 26px;
        line-height: 1;
        cursor: pointer;
    }

    // Windy's switch component, matched to the mock: equal items (flex: 1 1 0, not switch--stretch, whose
    // width: 100% plus the side margins overflows the box), light selected tab.
    .help__tabs {
        display: flex;
        box-sizing: border-box;
        width: auto;
        margin: 0 var(--pad) 4px;
        padding: 2px;
        border-radius: 7px;
        background: rgba(255, 255, 255, 0.1);
    }

    .help__tab {
        flex: 1 1 0;
        min-width: 0;
        min-height: 36px;
        padding: 4px 2px;
        border: 0;
        border-radius: 5px;
        background: none;
        color: #d0d0d0;
        font: inherit;
        font-size: 13px;
        white-space: nowrap; // five tabs on a 360 px phone: one row, an ellipsis at worst
        overflow: hidden;
        text-overflow: ellipsis;
        cursor: pointer;

        &.selected {
            background: #e6e6e6;
            color: #222222;
            font-weight: 700;
        }
    }

    .help__content {
        flex-grow: 1;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 14px var(--pad) 20px;
        font-size: 14px;
        line-height: 1.5;
        color: #d9d9d9;

        h3 {
            margin: 0 0 6px;
            font-size: 15px;
            color: #ffffff;
        }

        p {
            margin: 0 0 14px;
        }

        ul {
            margin: 0 0 14px;
            padding-left: 18px;
        }

        b {
            color: #ffffff;
        }
    }

    .help__lead {
        font-size: 15px;
        color: #ffffff;
    }

    .help__cards {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-bottom: 14px;
    }

    .help__card {
        display: flex;
        gap: 12px;
        align-items: flex-start;
        text-align: left;
        padding: 12px;
        border: 0;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.06);
        color: inherit;
        font: inherit;
        cursor: pointer;

        svg {
            flex-shrink: 0;
        }
    }

    .help__note {
        padding: 12px;
        border-radius: 8px;
        background: rgba(240, 168, 28, 0.12);
        color: #f2e3c4;
    }

    .help__link {
        display: inline;
        padding: 0;
        border: 0;
        background: none;
        color: #f0a81c;
        font: inherit;
        text-decoration: underline;
        cursor: pointer;
    }

    .help__figure {
        display: block;
        margin-bottom: 12px;
    }

    .help__content .help__before-figure {
        margin-bottom: 10px;
    }

    .help__figure--legend {
        margin-bottom: 6px;
    }

    // Decorative swatches: the text carries the meaning.
    .help__legend {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 16px;
        margin-bottom: 12px;
        font-size: 13px;

        > span {
            display: flex;
            align-items: center;
            gap: 6px;
        }
    }

    .help__swatch {
        width: 14px;
        height: 10px;
        border-radius: 2px;
    }

    .help__content p.help__tight {
        margin-bottom: 6px;
    }

    .help__content p.help__last {
        margin-bottom: 0;
    }

    .help__hint {
        color: #b5b5b5;
        font-size: 13px;
    }

    .help__aside {
        font-weight: 400;
        font-size: 13px;
        color: #b5b5b5;
    }

    .help__content h3.help__limits-title {
        margin-bottom: 10px;
    }

    .help__limits {
        display: flex;
        flex-direction: column;
        gap: 12px;

        p {
            margin: 0;
        }
    }
</style>
